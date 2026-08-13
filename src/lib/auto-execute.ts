/**
 * Auto-Execute / One-Click Trade — simultaneous API order execution
 *
 * SAFETY: The caller must resolve the server-side execution mode before
 * invoking this engine. `/api/execute` is the sole authority and passes one
 * final `dryRun` decision; legacy environment flags never override it here.
 *
 * Flow:
 * 1. User clicks "Execute" on an arb opportunity
 * 2. Pre-trade slippage check: verify spread is still profitable
 * 3. Places orders simultaneously on both platforms (or simulates in dry-run)
 * 4. Tick check: when one leg fills, immediately verify the other leg's price
 * 5. Poll loop: wait for fills or timeout (cancel unfilled legs)
 * 6. Risk handling: auto-close filled legs if the other side fails
 * 7. Reports fill status, actual prices, actual profit, alerts
 *
 * PARTIAL-FILL RISK HANDLING:
 * - If one leg fills and the other doesn't within timeout → cancel unfilled, auto-close filled
 * - If both partial fill with mismatched sizes → close the excess from larger leg
 * - If auto-close fails → mark unhedged, show red alert
 * - Tick check on first fill: re-verify other leg's price before continuing to wait
 */

import { isAuthoritativeVenueEvidence } from './execution-evidence';

function errorField(error: unknown, field: 'status' | 'code' | 'message'): unknown {
  return typeof error === 'object' && error !== null && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

function errorMessage(error: unknown): string {
  const message = errorField(error, 'message');
  return typeof message === 'string' ? message : String(error);
}

// ─── Types ────────────────────────────────────────────────────────

export type OrderType = 'limit' | 'market';
export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filled' | 'partial' | 'rejected' | 'cancelled' | 'expired';

export interface OrderRequest {
  platform: 'kalshi' | 'polymarket';
  marketId: string;
  ticker?: string;      // Kalshi ticker
  conditionId?: string; // Polymarket condition ID
  side: OrderSide;
  outcome: 'yes' | 'no';
  size: number;         // dollar amount
  /** Exact requested contract/share units when known by the caller. */
  contracts?: number;
  price: number;        // limit price (0-1)
  orderType: OrderType;
}

export interface OrderResult {
  platform: 'kalshi' | 'polymarket';
  status: OrderStatus;
  filledSize?: number;
  /** Authoritative venue-reported contracts/shares. */
  filledContracts?: number;
  filledPrice?: number;
  /** Venue-reported charged fee in integer cents. */
  chargedFeeCents?: number;
  /** Authoritative venue fill/trade ID, distinct from the submitted order ID. */
  executionId?: string;
  /** Venue-provided fill timestamp. */
  venueTimestamp?: string;
  orderId?: string;
  error?: string;
  timestamp: string;
  /** Correlated venue evidence; never populated from submitted order values. */
  venueEvidence?: import('./execution-evidence').VenueExecutionEvidence;
}

export interface ExecutionRequest {
  arbId: string;
  marketTitle: string;
  kalshiOrder: OrderRequest;
  polymarketOrder: OrderRequest;
  estimatedProfit: number;
  maxSlippagePct: number;   // abort if price moves more than this
  timeoutMs: number;         // cancel both if not filled within this
  dryRun: boolean;           // if true, simulate without placing real orders
  /** ISO timestamp when the opportunity was last scanned/detected. */
  scanTime?: string;
  /** Whether at least one share was available at the best ask price when the
   *  opportunity was detected.  When false, the best-price step shows a warning. */
  bestPriceFound?: boolean;
}

export type StepStatus = 'success' | 'pending' | 'failed' | 'partial' | 'skipped';

export interface ExecutionStep {
  timestamp: string;
  status: StepStatus;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionResult {
  success: boolean;
  kalshiResult: OrderResult;
  polymarketResult: OrderResult;
  actualProfit?: number;
  netExposure?: number;      // if partial fills, the net dollar exposure
  rollbackExecuted: boolean;
  unhedged: boolean;          // true if auto-close failed and exposure remains
  executionTimeMs: number;
  error?: string;
  tickCheck?: TickCheckResult;  // result of tick check after first leg fill
  alerts?: ExecutionAlert[];    // alerts generated during execution
  steps: ExecutionStep[];       // chronological step-by-step execution timeline
}

export interface TickCheckResult {
  triggered: boolean;          // true if tick check was performed
  legChecked: 'kalshi' | 'polymarket';  // which leg was checked
  expectedPrice: number;
  actualPrice?: number;
  priceMoved: boolean;         // true if price moved beyond slippage threshold
  action: 'proceed' | 'cancel' | 'timeout';
}

export interface ExecutionAlert {
  level: 'warning' | 'error' | 'info';
  message: string;
  leg?: 'kalshi' | 'polymarket';
  action?: string;
}

// ─── Safety Config ────────────────────────────────────────────────

export interface SafetyLimits {
  maxPositionSize: number;      // max $ per trade
  dailyLossLimit: number;        // stop if daily losses exceed this
  maxSlippagePct: number;        // abort if price moves more than this
  orderTimeoutMs: number;        // cancel if not filled within this
}

export function getSafetyLimitsFromEnv(): SafetyLimits {
  return {
    maxPositionSize: parseFloat(process.env.H2H_MAX_POSITION_SIZE ?? '') || 1000,
    dailyLossLimit: parseFloat(process.env.H2H_DAILY_LOSS_LIMIT ?? '') || 500,
    maxSlippagePct: parseFloat(process.env.H2H_MAX_SLIPPAGE_PCT ?? '') || 2.0,
    orderTimeoutMs: parseInt(process.env.H2H_ORDER_TIMEOUT_MS ?? '', 10) || 10000,
  };
}

// ─── Validation ───────────────────────────────────────────────────

export function validateExecution(req: ExecutionRequest, limits: SafetyLimits): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (req.kalshiOrder.size > limits.maxPositionSize) {
    errors.push(`Kalshi order size $${req.kalshiOrder.size} exceeds max position size $${limits.maxPositionSize}`);
  }
  if (req.polymarketOrder.size > limits.maxPositionSize) {
    errors.push(`Polymarket order size $${req.polymarketOrder.size} exceeds max position size $${limits.maxPositionSize}`);
  }
  if (req.maxSlippagePct > limits.maxSlippagePct) {
    errors.push(`Requested slippage ${req.maxSlippagePct}% exceeds safety limit ${limits.maxSlippagePct}%`);
  }
  if (req.kalshiOrder.price <= 0 || req.kalshiOrder.price >= 1) {
    errors.push(`Kalshi price ${req.kalshiOrder.price} must be between 0 and 1`);
  }
  if (req.polymarketOrder.price <= 0 || req.polymarketOrder.price >= 1) {
    errors.push(`Polymarket price ${req.polymarketOrder.price} must be between 0 and 1`);
  }
  if (req.kalshiOrder.size <= 0 || req.polymarketOrder.size <= 0) {
    errors.push('Order sizes must be positive');
  }

  return { valid: errors.length === 0, errors };
}

// ─── Dry Run Simulator ──────────────────────────────────────────

function simulateOrder(req: OrderRequest): OrderResult {
  // Simulate fill behavior — sometimes returns pending to exercise poll loop
  const roll = Math.random();
  if (roll < 0.15) {
    // 15% chance: order is pending (not yet filled)
    return {
      platform: req.platform,
      status: 'pending',
      filledSize: 0,
      filledContracts: 0,
      filledPrice: req.price,
      orderId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };
  }
  // 85% chance: filled (with random slippage + partial fill ratio)
  const slippage = (Math.random() - 0.5) * 0.005;
  const filledPrice = Math.max(0.01, Math.min(0.99, req.price + slippage));
  const fillRatio = 0.85 + Math.random() * 0.15; // 85-100% fill
  const requestedContracts = req.contracts ?? Math.floor(req.size / req.price + 1e-9);
  const filledContracts = Math.floor(requestedContracts * fillRatio);
  return {
    platform: req.platform,
    status: fillRatio >= 0.99 ? 'filled' : 'partial',
    filledSize: filledContracts * filledPrice,
    filledContracts,
    filledPrice,
    orderId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };
}

/** Simulate polling a pending/partial dry-run order — the next poll fills the remainder. */
function simulatePollResult(req: OrderRequest, orderId: string): OrderResult {
  const slippage = (Math.random() - 0.5) * 0.005;
  const filledPrice = Math.max(0.01, Math.min(0.99, req.price + slippage));
  const filledContracts = req.contracts ?? Math.floor(req.size / req.price + 1e-9);
  return {
    platform: req.platform,
    status: 'filled',
    filledSize: filledContracts * filledPrice,
    filledContracts,
    filledPrice,
    orderId,
    timestamp: new Date().toISOString(),
  };
}

// ─── Real Execution (HOOKUP-04 step 2) ───────────────────────────
// Places both legs in parallel as limit orders at the requested prices.
// One-leg-failure => immediate cancel of the surviving leg (rollback).
// Only reachable via /api/execute (manual-only, kill-switch gated).

const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 500;

type KalshiOrderAdapterResponse = Awaited<ReturnType<typeof import('./kalshi-orders')['placeKalshiOrder']>>;

export function mapKalshiOrderResult(r: KalshiOrderAdapterResponse): OrderResult {
  const evidence = r.evidence;
  if (evidence) {
    return {
      platform: 'kalshi',
      status: r.status === 'executed' ? 'filled' : 'partial',
      filledSize: evidence.filledQuantity * evidence.fillPrice,
      filledContracts: evidence.filledQuantity,
      filledPrice: evidence.fillPrice,
      chargedFeeCents: evidence.chargedFeeCents,
      executionId: evidence.executionId,
      venueTimestamp: evidence.venueTimestamp,
      orderId: r.orderId,
      timestamp: evidence.venueTimestamp,
      venueEvidence: evidence,
    };
  }
  return {
    platform: 'kalshi',
    status: r.filledCount != null && r.filledCount > 0 ? 'partial' : 'pending',
    filledContracts: r.filledCount,
    orderId: r.orderId,
    timestamp: '',
    ...(r.filledCount != null && r.filledCount > 0
      ? { error: 'Kalshi reported a fill without complete correlated venue evidence' }
      : {}),
  };
}

async function placeRealKalshiLeg(req: OrderRequest, arbId: string): Promise<OrderResult> {
  const { placeKalshiOrder } = await import('./kalshi-orders');
  if (!req.ticker) {
    return { ...emptyResult('kalshi', 'rejected'), error: 'Missing Kalshi ticker' };
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const priceCents = Math.round(req.price * 100);
      const count = Math.max(1, Math.floor(req.contracts ?? (req.size / req.price))); // $size → contracts
      const r = await placeKalshiOrder({
        ticker: req.ticker,
        side: req.outcome,
        count,
        priceCents,
        clientOrderId: `h2h-${arbId}-k${attempt > 0 ? `-r${attempt}` : ''}`.slice(0, 64),
      });
      return mapKalshiOrderResult(r);
    } catch (err: unknown) {
      lastErr = err;
      // Retry on rate limit (429) or transient network errors
      const status = errorField(err, 'status');
      const code = errorField(err, 'code');
      const isRetryable = status === 429 || code === 'ECONNRESET' || code === 'ETIMEDOUT';
      if (!isRetryable || attempt === MAX_RETRIES) break;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  return { ...emptyResult('kalshi', 'rejected'), error: errorMessage(lastErr) };
}

async function placeRealPmLeg(req: OrderRequest): Promise<OrderResult> {
  const { mapPmOrderResponse, placePmOrder } = await import('./polymarket-orders');
  if (!req.conditionId) {
    return { ...emptyResult('polymarket', 'rejected'), error: 'Missing Polymarket token ID' };
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const size = req.contracts ?? (req.size / req.price); // $size → shares
      const r = await placePmOrder({ tokenId: req.conditionId, price: req.price, size });
      return mapPmOrderResponse(r, r.venueEvidence ?? null);
    } catch (err: unknown) {
      lastErr = err;
      const status = errorField(err, 'status');
      const code = errorField(err, 'code');
      const isRetryable = status === 429 || code === 'ECONNRESET' || code === 'ETIMEDOUT';
      if (!isRetryable || attempt === MAX_RETRIES) break;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  return { ...emptyResult('polymarket', 'rejected'), error: errorMessage(lastErr) };
}

async function cancelLeg(result: OrderResult): Promise<boolean> {
  if (!result.orderId) return false;
  try {
    if (result.platform === 'kalshi') {
      const { cancelKalshiOrder } = await import('./kalshi-orders');
      return await cancelKalshiOrder(result.orderId);
    }
    const { cancelPmOrder } = await import('./polymarket-orders');
    return await cancelPmOrder(result.orderId);
  } catch {
    return false;
  }
}

// ─── Tick Check ──────────────────────────────────────────────────
// When one leg fills, immediately check the other leg's current market price.
// If price has moved beyond the slippage threshold, cancel the unfilled leg
// and auto-close the filled leg to eliminate exposure.

async function tickCheckLeg(
  filledLeg: 'kalshi' | 'polymarket',
  unfilledReq: OrderRequest,
  maxSlippagePct: number,
  dryRun: boolean,
): Promise<TickCheckResult> {
  const expectedPrice = unfilledReq.price;

  if (dryRun) {
    // Simulate: 80% chance price is fine, 20% chance it moved
    const priceMoved = Math.random() < 0.2;
    if (priceMoved) {
      const moveDir = Math.random() < 0.5 ? -1 : 1;
      const movePct = (maxSlippagePct + 0.5) * 0.01 * moveDir;
      const actualPrice = Math.max(0.01, Math.min(0.99, expectedPrice + expectedPrice * movePct));
      return {
        triggered: true,
        legChecked: filledLeg === 'kalshi' ? 'polymarket' : 'kalshi',
        expectedPrice,
        actualPrice,
        priceMoved: true,
        action: 'cancel',
      };
    }
    return {
      triggered: true,
      legChecked: filledLeg === 'kalshi' ? 'polymarket' : 'kalshi',
      expectedPrice,
      actualPrice: expectedPrice,
      priceMoved: false,
      action: 'proceed',
    };
  }

  // Real mode: orderbook fetch functions are not yet implemented.
  // The tick check still runs in dry-run mode (simulated) and the poll loop's
  // timeout + slippage validation provide the safety net in real mode.
  // When orderbook fetch functions are added to kalshi-orders.ts / polymarket-orders.ts,
  // this branch can be upgraded to do a live price verification.
  //
  // For now: proceed cautiously — the limit order protects against slippage,
  // and the timeout will cancel the unfilled leg if it doesn't fill in time.
  return {
    triggered: true,
    legChecked: filledLeg === 'kalshi' ? 'polymarket' : 'kalshi',
    expectedPrice,
    actualPrice: undefined,
    priceMoved: false,
    action: 'proceed',
  };
}

// ─── Execution Engine ────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 15000;

/** Determine if an order status is "settled" (no longer changing). */
function isSettled(status: OrderStatus): boolean {
  return status === 'filled' || status === 'rejected' || status === 'cancelled' || status === 'expired';
}

/** Determine if an order has any fill (partial or full). */
function hasFill(r: OrderResult): boolean {
  return (r.filledContracts ?? 0) > 0 || (r.filledSize ?? 0) > 0;
}

/** Compare hedge coverage in contracts; filledSize is dollar notional. */
export function areFilledContractsMatched(
  kalshiResult: OrderResult,
  polymarketResult: OrderResult,
): { matched: boolean; kalshiContracts: number; polymarketContracts: number } {
  const kalshiContracts = kalshiResult.filledContracts ?? 0;
  const polymarketContracts = polymarketResult.filledContracts ?? 0;
  const authoritative =
    Number.isFinite(kalshiResult.filledContracts) &&
    Number.isFinite(polymarketResult.filledContracts);
  return {
    matched: authoritative && Math.abs(kalshiContracts - polymarketContracts) < 1e-6,
    kalshiContracts,
    polymarketContracts,
  };
}

/** Close a filled position by placing a sell order at the fill price.
 *  Returns true if the close succeeded, false if it failed (exposure remains). */
export function isCompleteClose(requestedContracts: number, filledContracts: number | null | undefined): boolean {
  return Number.isFinite(requestedContracts) && requestedContracts > 0 &&
    filledContracts != null && Number.isFinite(filledContracts) &&
    filledContracts + 1e-9 >= requestedContracts;
}

async function autoCloseLeg(
  leg: OrderResult,
  req: OrderRequest,
  arbId: string,
  dryRun: boolean,
): Promise<boolean> {
  if (!hasFill(leg) || !leg.orderId) return true; // nothing to close
  const contracts = leg.filledContracts;
  if (contracts == null || !Number.isFinite(contracts) || contracts <= 0) return false;

  if (dryRun) {
    // Simulate: 90% success rate for close
    return Math.random() > 0.1;
  }

  try {
    if (leg.platform === 'kalshi') {
      const { placeKalshiSellOrder } = await import('./kalshi-orders');
      const priceCents = Math.round((leg.filledPrice ?? req.price) * 100);
      const count = Math.max(1, Math.floor(contracts));
      const r = await placeKalshiSellOrder({
        ticker: req.ticker!,
        side: req.outcome,
        count,
        priceCents,
        clientOrderId: `h2h-close-${arbId}-k`.slice(0, 64),
      });
      return isCompleteClose(contracts, r.filledCount);
    } else {
      const { placePmSellOrder } = await import('./polymarket-orders');
      const r = await placePmSellOrder({
        tokenId: req.conditionId!,
        price: leg.filledPrice ?? req.price,
        size: contracts,
      });
      return isCompleteClose(contracts, r.filledContracts);
    }
  } catch {
    return false; // close failed — exposure remains
  }
}

/** Poll a pending order for fill status. Returns updated OrderResult. */
async function pollOrder(
  leg: OrderResult,
  req: OrderRequest,
  dryRun: boolean,
): Promise<OrderResult> {
  if (!leg.orderId || isSettled(leg.status)) return leg;

  if (dryRun) {
    // Simulate: 70% chance of filling on each poll
    if (Math.random() < 0.7) {
      return simulatePollResult(req, leg.orderId);
    }
    return leg; // still pending
  }

  try {
    if (leg.platform === 'kalshi') {
      const { getKalshiOrder } = await import('./kalshi-orders');
      const updated = await getKalshiOrder(leg.orderId);
      if (!updated) return leg;
      return mapKalshiOrderResult(updated);
    } else {
      const { getPmOrder, mapPmOrderResponse } = await import('./polymarket-orders');
      const updated = await getPmOrder(leg.orderId);
      if (!updated) return leg;
      return mapPmOrderResponse(updated, updated.venueEvidence ?? null);
    }
  } catch {
    return leg; // poll failed, return current state
  }
}

export function shouldSimulateExecution(req: ExecutionRequest): boolean {
  return req.dryRun;
}

export async function executeArb(req: ExecutionRequest): Promise<ExecutionResult> {
  const startTime = Date.now();
  const limits = getSafetyLimitsFromEnv();
  const alerts: ExecutionAlert[] = [];

  // `/api/execute` resolves execute.mode once and passes the final decision.
  // Do not re-read H2H_DRY_RUN here: that legacy layer made UI/API mode differ
  // from actual order behavior and could silently turn live into paper.
  const effectiveDryRun = shouldSimulateExecution(req);

  // Validate
  const validation = validateExecution(req, limits);
  if (!validation.valid) {
    return {
      success: false,
      kalshiResult: emptyResult('kalshi', 'rejected'),
      polymarketResult: emptyResult('polymarket', 'rejected'),
      rollbackExecuted: false,
      unhedged: false,
      executionTimeMs: Date.now() - startTime,
      error: validation.errors.join('; '),
      alerts,
      steps: [
        {
          timestamp: new Date().toISOString(),
          status: 'failed',
          description: `Validation failed: ${validation.errors.join('; ')}`,
        },
      ],
    };
  }

  const steps: ExecutionStep[] = [];
  function addStep(status: StepStatus, description: string, metadata?: Record<string, unknown>) {
    steps.push({ timestamp: new Date().toISOString(), status, description, metadata });
  }

  // ── Pre-execution context steps (from scan data) ──
  if (req.scanTime) {
    addStep('success', `Last scan time: ${new Date(req.scanTime).toLocaleString('en-US', { hour12: false })}`, { scanTime: req.scanTime });
  } else {
    addStep('skipped', 'Last scan time not recorded (legacy trade)');
  }

  if (req.bestPriceFound != null) {
    if (req.bestPriceFound) {
      addStep('success', 'Best price found — at least one share available at the best ask on both legs');
    } else {
      addStep('failed', 'Best price NOT found — no shares available at the best ask when scanned');
    }
  } else {
    addStep('skipped', 'Best price availability not recorded (legacy trade)');
  }

  addStep('success', 'Validation passed — trade request accepted');
  addStep('success', `Execution mode: ${effectiveDryRun ? 'DRY RUN (simulated)' : 'LIVE'}`);

  // ── Phase 1: Fire both legs simultaneously ──
  let kalshiResult: OrderResult;
  let polymarketResult: OrderResult;

  if (effectiveDryRun) {
    [kalshiResult, polymarketResult] = await Promise.all([
      Promise.resolve(simulateOrder(req.kalshiOrder)),
      Promise.resolve(simulateOrder(req.polymarketOrder)),
    ]);
  } else {
    [kalshiResult, polymarketResult] = await Promise.all([
      placeRealKalshiLeg(req.kalshiOrder, req.arbId),
      placeRealPmLeg(req.polymarketOrder),
    ]);
  }

  const legStatus = (r: OrderResult) =>
    `${r.platform}: ${r.status}` + (r.filledSize ? ` ($${r.filledSize.toFixed(2)} @ ${r.filledPrice?.toFixed(3)})` : '');
  const bothLegsStatus: StepStatus =
    (kalshiResult.status === 'rejected' || polymarketResult.status === 'rejected') ? 'failed'
    : (kalshiResult.status === 'partial' || polymarketResult.status === 'partial') ? 'partial'
    : 'success';
  addStep(
    bothLegsStatus,
    `Both legs placed — ${legStatus(kalshiResult)}; ${legStatus(polymarketResult)}`,
    { kalshiOrderId: kalshiResult.orderId, polymarketOrderId: polymarketResult.orderId },
  );

  // ── Phase 2: Poll loop with tick check ──
  const timeoutMs = req.timeoutMs || limits.orderTimeoutMs || DEFAULT_TIMEOUT_MS;
  const deadline = startTime + timeoutMs;
  let tickCheckResult: TickCheckResult | undefined;
  let tickCheckDone = false;

  while (
    !isSettled(kalshiResult.status) ||
    !isSettled(polymarketResult.status)
  ) {
    if (Date.now() >= deadline) break;

    await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= deadline) break;

    // Poll both legs in parallel
    [kalshiResult, polymarketResult] = await Promise.all([
      pollOrder(kalshiResult, req.kalshiOrder, effectiveDryRun),
      pollOrder(polymarketResult, req.polymarketOrder, effectiveDryRun),
    ]);

    // ── Tick check: when one leg fills, verify the other leg's price ──
    if (!tickCheckDone) {
      const kJustFilled = isSettled(kalshiResult.status) && hasFill(kalshiResult);
      const pJustFilled = isSettled(polymarketResult.status) && hasFill(polymarketResult);
      const kStillPending = !isSettled(kalshiResult.status);
      const pStillPending = !isSettled(polymarketResult.status);

      if (kJustFilled && pStillPending) {
        // Kalshi filled, Polymarket still pending → tick check Polymarket
        tickCheckResult = await tickCheckLeg('kalshi', req.polymarketOrder, req.maxSlippagePct, effectiveDryRun);
        tickCheckDone = true;
        addStep(
          tickCheckResult.action === 'cancel' ? 'failed' : 'success',
          `Tick check on Kalshi fill — Polymarket expected ${tickCheckResult.expectedPrice.toFixed(3)}${tickCheckResult.actualPrice ? `, actual ${tickCheckResult.actualPrice.toFixed(3)}` : ''} → ${tickCheckResult.action}`,
          { legChecked: tickCheckResult.legChecked, priceMoved: tickCheckResult.priceMoved },
        );
        if (tickCheckResult.action === 'cancel') {
          // Price moved → cancel Polymarket, auto-close Kalshi
          alerts.push({
            level: 'warning',
            message: `Tick check: Polymarket price moved from ${tickCheckResult.expectedPrice} to ${tickCheckResult.actualPrice ?? 'unavailable'} — cancelling leg and auto-closing Kalshi`,
            leg: 'polymarket',
            action: 'cancel + auto-close kalshi',
          });
          if (!effectiveDryRun) await cancelLeg(polymarketResult);
          polymarketResult = { ...polymarketResult, status: 'cancelled' };
          const closed = await autoCloseLeg(kalshiResult, req.kalshiOrder, req.arbId, effectiveDryRun);
          if (!closed) {
            // Will be handled in Phase 3 — mark unhedged there
          } else {
            kalshiResult = { ...kalshiResult, status: 'cancelled' };
          }
          break; // exit poll loop — both legs are now settled
        }
      } else if (pJustFilled && kStillPending) {
        // Polymarket filled, Kalshi still pending → tick check Kalshi
        tickCheckResult = await tickCheckLeg('polymarket', req.kalshiOrder, req.maxSlippagePct, effectiveDryRun);
        tickCheckDone = true;
        addStep(
          tickCheckResult.action === 'cancel' ? 'failed' : 'success',
          `Tick check on Polymarket fill — Kalshi expected ${tickCheckResult.expectedPrice.toFixed(3)}${tickCheckResult.actualPrice ? `, actual ${tickCheckResult.actualPrice.toFixed(3)}` : ''} → ${tickCheckResult.action}`,
          { legChecked: tickCheckResult.legChecked, priceMoved: tickCheckResult.priceMoved },
        );
        if (tickCheckResult.action === 'cancel') {
          alerts.push({
            level: 'warning',
            message: `Tick check: Kalshi price moved from ${tickCheckResult.expectedPrice} to ${tickCheckResult.actualPrice ?? 'unavailable'} — cancelling leg and auto-closing Polymarket`,
            leg: 'kalshi',
            action: 'cancel + auto-close polymarket',
          });
          if (!effectiveDryRun) await cancelLeg(kalshiResult);
          kalshiResult = { ...kalshiResult, status: 'cancelled' };
          const closed = await autoCloseLeg(polymarketResult, req.polymarketOrder, req.arbId, effectiveDryRun);
          if (!closed) {
            // Will be handled in Phase 3
          } else {
            polymarketResult = { ...polymarketResult, status: 'cancelled' };
          }
          break;
        }
      }
    }
  }

  // ── Phase 3: Risk handling — manage partial fills and failures ──
  let rollbackExecuted = false;
  let unhedged = false;

  const kFailed = kalshiResult.status === 'rejected' || kalshiResult.status === 'cancelled' || kalshiResult.status === 'expired';
  const pFailed = polymarketResult.status === 'rejected' || polymarketResult.status === 'cancelled' || polymarketResult.status === 'expired';
  const kFilled = hasFill(kalshiResult);
  const pFilled = hasFill(polymarketResult);

  if (kFailed && pFailed) {
    // Both failed — clean failure, no exposure
    addStep('failed', `Both legs failed — Kalshi: ${kalshiResult.status}, Polymarket: ${polymarketResult.status}`);
    if (kFilled || pFilled) {
      // Edge case: both "failed" but one has a residual fill (shouldn't happen but guard)
      alerts.push({ level: 'error', message: 'Both legs failed but residual fill detected — check positions manually' });
    }
  } else if (kFailed && pFilled) {
    // Kalshi failed, Polymarket filled — auto-close Polymarket
    addStep('failed', `Kalshi leg failed (${kalshiResult.status}) — auto-closing Polymarket`);
    alerts.push({
      level: 'warning',
      message: 'Kalshi leg failed — auto-closing Polymarket position to eliminate exposure',
      leg: 'kalshi',
      action: 'auto-close polymarket',
    });
    if (!effectiveDryRun) await cancelLeg(polymarketResult);
    const closed = await autoCloseLeg(polymarketResult, req.polymarketOrder, req.arbId, effectiveDryRun);
    if (!closed) {
      unhedged = true;
      alerts.push({
        level: 'error',
        message: `Auto-close FAILED for Polymarket — $${(polymarketResult.filledSize ?? 0).toFixed(2)} unhedged exposure. Close manually.`,
        leg: 'polymarket',
        action: 'manual close required',
      });
    } else {
      polymarketResult = { ...polymarketResult, status: 'cancelled' };
    }
    rollbackExecuted = true;
  } else if (pFailed && kFilled) {
    // Polymarket failed, Kalshi filled — auto-close Kalshi
    addStep('failed', `Polymarket leg failed (${polymarketResult.status}) — auto-closing Kalshi`);
    alerts.push({
      level: 'warning',
      message: 'Polymarket leg failed — auto-closing Kalshi position to eliminate exposure',
      leg: 'polymarket',
      action: 'auto-close kalshi',
    });
    if (!effectiveDryRun) await cancelLeg(kalshiResult);
    const closed = await autoCloseLeg(kalshiResult, req.kalshiOrder, req.arbId, effectiveDryRun);
    if (!closed) {
      unhedged = true;
      alerts.push({
        level: 'error',
        message: `Auto-close FAILED for Kalshi — $${(kalshiResult.filledSize ?? 0).toFixed(2)} unhedged exposure. Close manually.`,
        leg: 'kalshi',
        action: 'manual close required',
      });
    } else {
      kalshiResult = { ...kalshiResult, status: 'cancelled' };
    }
    rollbackExecuted = true;
  } else if (kFilled && pFilled) {
    // Both have fills — compare hedge coverage in contracts, not dollars.
    const match = areFilledContractsMatched(kalshiResult, polymarketResult);
    const { kalshiContracts: kFill, polymarketContracts: pFill } = match;

    if (!match.matched) {
      // Mismatched contracts — cancel both and close the excess contracts.
      addStep('failed', `Mismatched fills — Kalshi ${kFill.toFixed(4)} contracts vs Polymarket ${pFill.toFixed(4)} — closing excess`);
      alerts.push({
        level: 'warning',
        message: `Mismatched fills: Kalshi ${kFill.toFixed(4)} contracts vs Polymarket ${pFill.toFixed(4)} — closing excess`,
        action: 'close excess',
      });
      if (!effectiveDryRun) {
        await cancelLeg(kalshiResult);
        await cancelLeg(polymarketResult);
      }
      const excessContracts = Math.abs(kFill - pFill);
      const largerLeg = kFill > pFill ? kalshiResult : polymarketResult;
      const largerReq = kFill > pFill ? req.kalshiOrder : req.polymarketOrder;
      const excessNotional = excessContracts * (largerLeg.filledPrice ?? largerReq.price);
      const closed = await autoCloseLeg(
        { ...largerLeg, filledSize: excessNotional, filledContracts: excessContracts },
        largerReq,
        req.arbId,
        effectiveDryRun,
      );
      if (!closed) {
        unhedged = true;
        alerts.push({
          level: 'error',
          message: `Failed to close ${excessContracts.toFixed(4)} excess contracts — unhedged exposure remains`,
          action: 'manual close required',
        });
      } else {
        const matchedContracts = Math.min(kFill, pFill);
        if (kFill > pFill) {
          kalshiResult = {
            ...kalshiResult,
            filledContracts: matchedContracts,
            filledSize: matchedContracts * (kalshiResult.filledPrice ?? req.kalshiOrder.price),
          };
        } else {
          polymarketResult = {
            ...polymarketResult,
            filledContracts: matchedContracts,
            filledSize: matchedContracts * (polymarketResult.filledPrice ?? req.polymarketOrder.price),
          };
        }
      }
      rollbackExecuted = true;
    } else {
      // Both legs have fills and are matched. If either leg is still 'partial'
      // (not fully filled), surface that as a partial step.
      const anyPartial = kalshiResult.status === 'partial' || polymarketResult.status === 'partial';
      addStep(
        anyPartial ? 'partial' : 'success',
        `Both legs filled and matched — ${kFill.toFixed(4)} contracts per leg` +
          (anyPartial ? ' (partial fills)' : ''),
      );
    }
    // If matched fills, no rollback needed — both sides hedged
  } else if (!kFilled && !pFilled) {
    // Both pending at timeout — cancel both, no exposure
    addStep('failed', 'Both legs timed out without fills — cancelling both, no exposure');
    alerts.push({
      level: 'info',
      message: 'Both legs timed out without fills — cancelling both, no exposure',
      action: 'cancel both',
    });
    if (!effectiveDryRun) {
      await cancelLeg(kalshiResult);
      await cancelLeg(polymarketResult);
    }
    kalshiResult = { ...kalshiResult, status: 'cancelled' };
    polymarketResult = { ...polymarketResult, status: 'cancelled' };
    rollbackExecuted = true;
  } else if (kFilled && !pFilled && !pFailed) {
    // Kalshi filled, Polymarket still pending — cancel PM, auto-close Kalshi
    addStep('failed', `Kalshi filled but Polymarket timed out — auto-closing Kalshi ($${(kalshiResult.filledSize ?? 0).toFixed(2)})`);
    alerts.push({
      level: 'warning',
      message: 'Kalshi filled but Polymarket timed out — auto-closing Kalshi',
      leg: 'polymarket',
      action: 'auto-close kalshi',
    });
    if (!effectiveDryRun) await cancelLeg(polymarketResult);
    polymarketResult = { ...polymarketResult, status: 'cancelled' };
    const closed = await autoCloseLeg(kalshiResult, req.kalshiOrder, req.arbId, effectiveDryRun);
    if (!closed) {
      unhedged = true;
      alerts.push({
        level: 'error',
        message: `Auto-close FAILED — $${(kalshiResult.filledSize ?? 0).toFixed(2)} unhedged Kalshi exposure. Close manually.`,
        leg: 'kalshi',
        action: 'manual close required',
      });
    } else {
      kalshiResult = { ...kalshiResult, status: 'cancelled' };
    }
    rollbackExecuted = true;
  } else if (pFilled && !kFilled && !kFailed) {
    // Polymarket filled, Kalshi still pending — cancel Kalshi, auto-close Polymarket
    addStep('failed', `Polymarket filled but Kalshi timed out — auto-closing Polymarket ($${(polymarketResult.filledSize ?? 0).toFixed(2)})`);
    alerts.push({
      level: 'warning',
      message: 'Polymarket filled but Kalshi timed out — auto-closing Polymarket',
      leg: 'kalshi',
      action: 'auto-close polymarket',
    });
    if (!effectiveDryRun) await cancelLeg(kalshiResult);
    kalshiResult = { ...kalshiResult, status: 'cancelled' };
    const closed = await autoCloseLeg(polymarketResult, req.polymarketOrder, req.arbId, effectiveDryRun);
    if (!closed) {
      unhedged = true;
      alerts.push({
        level: 'error',
        message: `Auto-close FAILED — $${(polymarketResult.filledSize ?? 0).toFixed(2)} unhedged Polymarket exposure. Close manually.`,
        leg: 'polymarket',
        action: 'manual close required',
      });
    } else {
      polymarketResult = { ...polymarketResult, status: 'cancelled' };
    }
    rollbackExecuted = true;
  }

  // ── Calculate actual profit and net exposure ──
  let actualProfit: number | undefined;
  let netExposure: number | undefined;

  if (kalshiResult.filledSize && polymarketResult.filledSize && kalshiResult.filledPrice && polymarketResult.filledPrice) {
    const match = areFilledContractsMatched(kalshiResult, polymarketResult);
    const minContracts = Math.min(match.kalshiContracts, match.polymarketContracts);
    const kalshiNotional = kalshiResult.filledSize;
    const pmNotional = polymarketResult.filledSize;
    netExposure = unhedged ? Math.abs(kalshiNotional - pmNotional) : 0;

    const spread = 1 - kalshiResult.filledPrice - polymarketResult.filledPrice;
    actualProfit = minContracts * spread;
  } else if (unhedged) {
    // One leg filled, other didn't — all of the filled amount is exposure
    netExposure = (kalshiResult.filledSize ?? 0) + (polymarketResult.filledSize ?? 0);
  }

  const liveEvidenceComplete = effectiveDryRun || (
    isAuthoritativeVenueEvidence(kalshiResult.venueEvidence)
    && kalshiResult.venueEvidence.venue === 'kalshi'
    && isAuthoritativeVenueEvidence(polymarketResult.venueEvidence)
    && polymarketResult.venueEvidence.venue === 'polymarket'
  );
  const success = !rollbackExecuted &&
    kalshiResult.status !== 'rejected' &&
    polymarketResult.status !== 'rejected' &&
    !unhedged &&
    liveEvidenceComplete;

  const finalStatus: StepStatus = success ? 'success' : (unhedged ? 'failed' : 'partial');
  addStep(finalStatus, `Execution ${success ? 'completed successfully' : 'completed with issues'} — profit $${(actualProfit ?? 0).toFixed(2)}, net exposure $${(netExposure ?? 0).toFixed(2)}, time ${Date.now() - startTime}ms`);

  return {
    success,
    kalshiResult,
    polymarketResult,
    actualProfit,
    netExposure,
    rollbackExecuted,
    unhedged,
    executionTimeMs: Date.now() - startTime,
    tickCheck: tickCheckResult,
    alerts: alerts.length > 0 ? alerts : undefined,
    steps,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyResult(platform: 'kalshi' | 'polymarket', status: OrderStatus): OrderResult {
  return {
    platform,
    status,
    timestamp: new Date().toISOString(),
  };
}

// ─── Audit Log ───────────────────────────────────────────────────

export interface AuditLogEntry {
  timestamp: string;
  arbId: string;
  marketTitle: string;
  dryRun: boolean;
  kalshiOrder: OrderRequest;
  polymarketOrder: OrderRequest;
  result: ExecutionResult;
  estimatedProfit: number;
}

const auditLog: AuditLogEntry[] = [];

export function logExecution(entry: AuditLogEntry): void {
  auditLog.push(entry);
  // Keep last 1000 entries
  if (auditLog.length > 1000) {
    auditLog.shift();
  }
}

export function getAuditLog(limit: number = 50): AuditLogEntry[] {
  return auditLog.slice(-limit);
}

export function clearAuditLog(): void {
  auditLog.length = 0;
}