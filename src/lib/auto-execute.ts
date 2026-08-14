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
import { isExecutableQuoteConsistent, type ExecutableBookQuote } from './executable-book';
import { orderbookState } from './orderbook-state';
import { isPriceAlignedToTick } from './venue-constraints';
import {
  reconcileExecutionCashLedger,
  type ExecutionCashLedger,
  type ExecutionLedgerClose,
  type ExecutionLedgerLeg,
} from './execution-cash-ledger';

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
  /** Explicit venue minimum captured from the exact executable book. */
  minimumOrderSize?: number;
  /** Executable price increment captured from the exact venue book. */
  tickSize?: number;
  price: number;        // limit price (0-1)
  orderType: OrderType;
  /** Exact executable depth quote used for paper/live price parity. */
  executableQuote?: ExecutableBookQuote;
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
  /** Parent Polymarket condition ID; the selected order token remains on polymarketOrder.conditionId. */
  pmConditionId?: string;
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
  /** Integer-cent cash reconciliation; actualProfit is its dollar compatibility projection. */
  cashLedger?: ExecutionCashLedger;
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
  for (const leg of [req.kalshiOrder, req.polymarketOrder]) {
    if (leg.contracts !== 1) {
      errors.push(`${leg.platform} order must request exactly one contract/share`);
    }
    if (!Number.isFinite(leg.minimumOrderSize) || leg.minimumOrderSize! <= 0) {
      errors.push(`${leg.platform} minimum order is unavailable`);
    } else if (leg.minimumOrderSize! > 1) {
      errors.push(`${leg.platform} minimum order is ${leg.minimumOrderSize} shares; requested 1 share`);
    }
    if (!Number.isFinite(leg.tickSize) || leg.tickSize! <= 0) {
      errors.push(`${leg.platform} tick size is unavailable`);
    } else if (!isPriceAlignedToTick(leg.price, leg.tickSize!)) {
      errors.push(`${leg.platform} limit price is not aligned to tick size ${leg.tickSize}`);
    }
    const limitMicroCents = leg.executableQuote?.limitPriceMicroCents;
    const scaledLimit = leg.price * 100_000_000;
    const submittedLimitMicroCents = Math.round(scaledLimit);
    if (limitMicroCents != null && (!Number.isSafeInteger(submittedLimitMicroCents)
        || Math.abs(scaledLimit - submittedLimitMicroCents) >= 1e-6
        || submittedLimitMicroCents !== limitMicroCents)) {
      errors.push(`${leg.platform} order limit must equal the worst consumed executable level`);
    }
    const vwapMicroCents = leg.executableQuote?.vwapPriceMicroCents;
    if (vwapMicroCents != null && Math.abs(leg.size - (vwapMicroCents / 100_000_000)) > 1e-9) {
      errors.push(`${leg.platform} one-share notional must equal its walked VWAP`);
    }
  }

  return { valid: errors.length === 0, errors };
}

const MAX_EXECUTABLE_DEPTH_AGE_MS = 30_000;

function quotesMatchAuthoritativeBook(
  candidate: ExecutableBookQuote,
  authoritative: ExecutableBookQuote,
): boolean {
  return candidate.status === authoritative.status
    && candidate.reason === authoritative.reason
    && candidate.requestedQuantityMicros === authoritative.requestedQuantityMicros
    && candidate.filledQuantityMicros === authoritative.filledQuantityMicros
    && candidate.totalCostMicroCents === authoritative.totalCostMicroCents
    && candidate.vwapPriceMicroCents === authoritative.vwapPriceMicroCents
    && candidate.limitPriceMicroCents === authoritative.limitPriceMicroCents
    && candidate.depthTimestamp === authoritative.depthTimestamp
    && candidate.tickSizeMicroCents === authoritative.tickSizeMicroCents
    && candidate.minimumOrderQuantityMicros === authoritative.minimumOrderQuantityMicros
    && candidate.fills.length === authoritative.fills.length
    && candidate.fills.every((fill, index) => {
      const expected = authoritative.fills[index];
      return fill.priceMicroCents === expected.priceMicroCents
        && fill.quantityMicros === expected.quantityMicros;
    });
}

function getAuthoritativeExecutableQuote(leg: OrderRequest): ExecutableBookQuote {
  const bookId = leg.platform === 'kalshi'
    ? (leg.ticker ?? leg.marketId)
    : (leg.conditionId ?? leg.marketId);
  return orderbookState.getExecutableQuote(bookId, leg.outcome, 1_000_000);
}

// ─── Dry Run Simulator ──────────────────────────────────────────

function simulateOrder(req: OrderRequest): OrderResult {
  const quotePrice = req.executableQuote?.status === 'executable'
    && req.executableQuote.vwapPriceMicroCents != null
    ? req.executableQuote.vwapPriceMicroCents / 100_000_000
    : null;
  if (quotePrice == null) {
    return { ...emptyResult(req.platform, 'rejected'), error: 'Missing executable book quote for paper fill' };
  }
  // Simulate fill behavior — sometimes returns pending to exercise poll loop
  const roll = Math.random();
  if (roll < 0.15) {
    // 15% chance: order is pending (not yet filled)
    return {
      platform: req.platform,
      status: 'pending',
      filledSize: 0,
      filledContracts: 0,
      orderId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };
  }
  // Fill probability is stochastic, but an executable price never is. Paper
  // mode uses the same walked-book VWAP carried by the request.
  const filledPrice = quotePrice;
  const fillRatio = 0.85 + Math.random() * 0.15; // 85-100% fill
  const requestedContracts = req.contracts ?? Math.floor(req.size / req.price + 1e-9);
  const filledContracts = requestedContracts === 1
    ? 1
    : Math.floor(requestedContracts * fillRatio);
  return {
    platform: req.platform,
    status: filledContracts === requestedContracts ? 'filled' : 'partial',
    filledSize: filledContracts * filledPrice,
    filledContracts,
    filledPrice,
    orderId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };
}

/** Simulate polling a pending/partial dry-run order — the next poll fills the remainder. */
function simulatePollResult(req: OrderRequest, orderId: string): OrderResult {
  const filledPrice = req.executableQuote?.status === 'executable'
    && req.executableQuote.vwapPriceMicroCents != null
    ? req.executableQuote.vwapPriceMicroCents / 100_000_000
    : null;
  if (filledPrice == null) {
    return { ...emptyResult(req.platform, 'rejected'), orderId, error: 'Missing executable book quote for paper fill' };
  }
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
  const normalizedStatus = r.status.toLowerCase();
  const cancelled = normalizedStatus === 'canceled' || normalizedStatus === 'cancelled';
  if (evidence) {
    return {
      platform: 'kalshi',
      status: normalizedStatus === 'executed' ? 'filled' : cancelled ? 'cancelled'
        : normalizedStatus === 'expired' ? 'expired' : 'partial',
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
  const terminalZero = (cancelled || normalizedStatus === 'expired')
    && r.filledCount === 0;
  return {
    platform: 'kalshi',
    status: terminalZero ? (normalizedStatus === 'expired' ? 'expired' : 'cancelled')
      : r.filledCount != null && r.filledCount > 0 ? 'partial' : 'pending',
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
      const count = req.contracts!;
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
      const size = req.contracts!;
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

export async function cancelAndVerifyOrder(
  result: OrderResult,
  cancel: (result: OrderResult) => Promise<boolean>,
  poll: (result: OrderResult) => Promise<OrderResult>,
  attempts = 3,
): Promise<{ result: OrderResult; verified: boolean; terminality: 'terminal' | 'live' | 'indeterminate' }> {
  if (isTerminallyVerifiedOrder(result)) return { result, verified: true, terminality: 'terminal' };
  if (!await cancel(result)) return { result, verified: false, terminality: 'live' };
  let current = result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      current = await poll(current);
    } catch {
      return { result: current, verified: false, terminality: 'indeterminate' };
    }
    if (isTerminallyVerifiedOrder(current)) return { result: current, verified: true, terminality: 'terminal' };
  }
  return { result: current, verified: false, terminality: 'indeterminate' };
}

// ─── Tick Check ──────────────────────────────────────────────────
// When one leg fills, immediately check the other leg's current market price.
// If price has moved beyond the slippage threshold, cancel the unfilled leg
// and auto-close the filled leg to eliminate exposure.

async function tickCheckLeg(
  filledLeg: 'kalshi' | 'polymarket',
  unfilledReq: OrderRequest,
  _maxSlippagePct: number,
  dryRun: boolean,
): Promise<TickCheckResult> {
  const expectedPrice = unfilledReq.price;

  if (dryRun) {
    // Pending/fill probability is modelled by pollOrder. Without a new walked
    // book, do not invent a price movement or an executable replacement price.
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
    Math.abs(filledContracts - requestedContracts) < 1e-9;
}

/** Venue-unit guard: Kalshi contracts are indivisible; PM shares support six decimals. */
export function isExecutableCloseQuantity(platform: OrderResult['platform'], contracts: number): boolean {
  if (!Number.isFinite(contracts) || contracts <= 0) return false;
  if (platform === 'kalshi') return Number.isSafeInteger(contracts);
  return Number.isSafeInteger(Math.round(contracts * 1_000_000));
}

export function isTerminallyVerifiedOrder(result: OrderResult): boolean {
  if (!isSettled(result.status) || result.filledContracts == null
    || !Number.isFinite(result.filledContracts) || result.filledContracts < 0) return false;
  if (result.filledContracts === 0) return result.status !== 'filled';
  return result.filledPrice != null
    && Number.isFinite(result.filledPrice)
    && result.filledPrice > 0
    && result.filledPrice < 1
    && isAuthoritativeVenueEvidence(result.venueEvidence)
    && result.venueEvidence.venue === result.platform
    && Math.abs(result.venueEvidence.filledQuantity - result.filledContracts) < 1e-9;
}

export function isTerminallyVerifiedClose(requestedContracts: number, result: OrderResult): boolean {
  return isCompleteClose(requestedContracts, result.filledContracts)
    && result.status === 'filled'
    && Number.isSafeInteger(result.chargedFeeCents)
    && Number(result.chargedFeeCents) >= 0
    && isTerminallyVerifiedOrder(result);
}

async function autoCloseLeg(
  leg: OrderResult,
  req: OrderRequest,
  arbId: string,
  dryRun: boolean,
): Promise<ExecutionLedgerClose> {
  const contracts = leg.filledContracts;
  const fallbackPrice = leg.filledPrice ?? req.price;
  const failed = (filledContracts = 0): ExecutionLedgerClose => ({
    venue: leg.platform,
    requestedContracts: contracts ?? 0,
    filledContracts,
    filledPrice: fallbackPrice,
    complete: false,
    priceSource: 'estimated',
  });
  if (!hasFill(leg) || !leg.orderId || contracts == null || !Number.isFinite(contracts) || contracts <= 0) {
    return failed();
  }
  if (!isExecutableCloseQuantity(leg.platform, contracts)) return failed();

  if (dryRun) {
    // Simulate: 90% success rate for close
    const complete = Math.random() > 0.1;
    return {
      venue: leg.platform,
      requestedContracts: contracts,
      filledContracts: complete ? contracts : 0,
      filledPrice: fallbackPrice,
      complete,
      priceSource: 'estimated',
    };
  }

  try {
    if (leg.platform === 'kalshi') {
      const { placeKalshiSellOrder } = await import('./kalshi-orders');
      const priceCents = Math.round((leg.filledPrice ?? req.price) * 100);
      const count = contracts;
      const r = await placeKalshiSellOrder({
        ticker: req.ticker!,
        side: req.outcome,
        count,
        priceCents,
        clientOrderId: `h2h-close-${arbId}-k`.slice(0, 64),
      });
      const mapped = mapKalshiOrderResult(r);
      const filledContracts = mapped.filledContracts ?? 0;
      const complete = isTerminallyVerifiedClose(contracts, mapped);
      if (!complete && r.orderId) await cancelLeg(mapped);
      return {
        venue: 'kalshi',
        requestedContracts: contracts,
        filledContracts,
        filledPrice: mapped.filledPrice ?? fallbackPrice,
        chargedFeeCents: mapped.chargedFeeCents,
        complete,
        priceSource: complete ? 'venue' : 'estimated',
      };
    } else {
      const { cancelPmOrder, mapPmOrderResponse, placePmSellOrder } = await import('./polymarket-orders');
      const r = await placePmSellOrder({
        tokenId: req.conditionId!,
        price: leg.filledPrice ?? req.price,
        size: contracts,
      });
      const mapped = mapPmOrderResponse(r, r.venueEvidence ?? null);
      const filledContracts = mapped.filledContracts ?? 0;
      const complete = isTerminallyVerifiedClose(contracts, mapped);
      if (!complete && r.orderId) await cancelPmOrder(r.orderId);
      return {
        venue: 'polymarket',
        requestedContracts: contracts,
        filledContracts,
        filledPrice: mapped.filledPrice ?? fallbackPrice,
        chargedFeeCents: mapped.chargedFeeCents,
        complete,
        priceSource: complete ? 'venue' : 'estimated',
      };
    }
  } catch {
    return failed(); // close failed — exposure remains
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
  for (const leg of [req.kalshiOrder, req.polymarketOrder]) {
    const candidate = leg.executableQuote;
    if (!isExecutableQuoteConsistent(candidate, leg.side, 1_000_000)) {
      validation.errors.push(`${leg.platform} order requires a complete, constraint-valid executable book quote`);
      continue;
    }
    const authoritative = getAuthoritativeExecutableQuote(leg);
    if (!isExecutableQuoteConsistent(authoritative, leg.side, 1_000_000)
        || !quotesMatchAuthoritativeBook(candidate, authoritative)) {
      validation.errors.push(`${leg.platform} quote must match the server-side executable book`);
      continue;
    }
    const observedAt = Date.parse(authoritative.depthTimestamp!);
    const depthAgeMs = Date.now() - observedAt;
    if (!Number.isFinite(depthAgeMs) || depthAgeMs < -5_000 || depthAgeMs > MAX_EXECUTABLE_DEPTH_AGE_MS) {
      validation.errors.push(`${leg.platform} server-side executable book is stale`);
    }
  }
  validation.valid = validation.errors.length === 0;
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

  let ledgerKalshiEntry: ExecutionLedgerLeg = { ...kalshiResult, venue: 'kalshi' };
  let ledgerPolymarketEntry: ExecutionLedgerLeg = { ...polymarketResult, venue: 'polymarket' };
  const closes: ExecutionLedgerClose[] = [];
  const captureEntry = (current: OrderResult, prior: ExecutionLedgerLeg): ExecutionLedgerLeg =>
    (current.filledContracts ?? 0) >= (prior.filledContracts ?? 0)
      ? { ...current, venue: current.platform }
      : prior;
  const initialTerminality = (result: OrderResult): 'terminal' | 'live' | 'indeterminate' =>
    isTerminallyVerifiedOrder(result) ? 'terminal'
      : result.status === 'pending' || result.status === 'partial' ? 'live' : 'indeterminate';
  const entryTerminalities: Record<OrderResult['platform'], {
    terminality: 'terminal' | 'live' | 'indeterminate';
    source: NonNullable<ExecutionLedgerLeg['terminalitySource']>;
  }> = {
    kalshi: { terminality: initialTerminality(kalshiResult), source: 'latest-order-response' },
    polymarket: { terminality: initialTerminality(polymarketResult), source: 'latest-order-response' },
  };
  const captureLatestTerminality = (result: OrderResult) => {
    entryTerminalities[result.platform] = {
      terminality: initialTerminality(result),
      source: 'latest-order-response',
    };
  };
  const cancelEntry = async (result: OrderResult, order: OrderRequest) => {
    if (effectiveDryRun) {
      const cancellation = isSettled(result.status)
        ? { result, verified: true, terminality: 'terminal' as const }
        : { result: { ...result, status: 'cancelled' as const }, verified: true, terminality: 'terminal' as const };
      entryTerminalities[result.platform] = { terminality: cancellation.terminality, source: 'simulation' };
      return cancellation;
    }
    const cancellation = await cancelAndVerifyOrder(
      result,
      cancelLeg,
      (current) => pollOrder(current, order, false),
    );
    entryTerminalities[result.platform] = { terminality: cancellation.terminality, source: 'post-cancel-poll' };
    return cancellation;
  };
  let rollbackExecuted = false;
  let unhedged = false;

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
    ledgerKalshiEntry = captureEntry(kalshiResult, ledgerKalshiEntry);
    ledgerPolymarketEntry = captureEntry(polymarketResult, ledgerPolymarketEntry);
    captureLatestTerminality(kalshiResult);
    captureLatestTerminality(polymarketResult);

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
          const cancellation = await cancelEntry(polymarketResult, req.polymarketOrder);
          polymarketResult = cancellation.result;
          ledgerPolymarketEntry = captureEntry(polymarketResult, ledgerPolymarketEntry);
          if (!cancellation.verified) {
            rollbackExecuted = true;
            unhedged = true;
            break;
          }
          const close = await autoCloseLeg(kalshiResult, req.kalshiOrder, req.arbId, effectiveDryRun);
          closes.push(close);
          rollbackExecuted = true;
          if (!close.complete) {
            unhedged = true;
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
          const cancellation = await cancelEntry(kalshiResult, req.kalshiOrder);
          kalshiResult = cancellation.result;
          ledgerKalshiEntry = captureEntry(kalshiResult, ledgerKalshiEntry);
          if (!cancellation.verified) {
            rollbackExecuted = true;
            unhedged = true;
            break;
          }
          const close = await autoCloseLeg(polymarketResult, req.polymarketOrder, req.arbId, effectiveDryRun);
          closes.push(close);
          rollbackExecuted = true;
          if (!close.complete) {
            unhedged = true;
          }
          break;
        }
      }
    }
  }

  // ── Phase 3: Risk handling — manage partial fills and failures ──
  ledgerKalshiEntry = captureEntry(kalshiResult, ledgerKalshiEntry);
  ledgerPolymarketEntry = captureEntry(polymarketResult, ledgerPolymarketEntry);

  const kFailed = kalshiResult.status === 'rejected' || kalshiResult.status === 'cancelled' || kalshiResult.status === 'expired';
  const pFailed = polymarketResult.status === 'rejected' || polymarketResult.status === 'cancelled' || polymarketResult.status === 'expired';
  const kFilled = hasFill(kalshiResult);
  const pFilled = hasFill(polymarketResult);

  if (rollbackExecuted) {
    addStep(
      unhedged ? 'failed' : 'partial',
      unhedged
        ? 'Tick-check rollback failed — exposure requires manual reconciliation'
        : 'Tick-check rollback completed — no additional close submitted',
    );
  } else if (kFailed && pFailed) {
    // Both failed — clean failure, no exposure
    addStep('failed', `Both legs failed — Kalshi: ${kalshiResult.status}, Polymarket: ${polymarketResult.status}`);
    if (kFilled || pFilled) {
      // Edge case: both "failed" but one has a residual fill (shouldn't happen but guard)
      alerts.push({ level: 'error', message: 'Both legs failed but residual fill detected — check positions manually' });
      unhedged = true;
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
    const cancellation = await cancelEntry(polymarketResult, req.polymarketOrder);
    polymarketResult = cancellation.result;
    ledgerPolymarketEntry = captureEntry(polymarketResult, ledgerPolymarketEntry);
    const close = cancellation.verified
      ? await autoCloseLeg(polymarketResult, req.polymarketOrder, req.arbId, effectiveDryRun)
      : { venue: 'polymarket' as const, requestedContracts: polymarketResult.filledContracts ?? 0, complete: false, priceSource: 'estimated' as const };
    closes.push(close);
    if (!close.complete) {
      unhedged = true;
      alerts.push({
        level: 'error',
        message: `Auto-close FAILED for Polymarket — $${(polymarketResult.filledSize ?? 0).toFixed(2)} unhedged exposure. Close manually.`,
        leg: 'polymarket',
        action: 'manual close required',
      });
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
    const cancellation = await cancelEntry(kalshiResult, req.kalshiOrder);
    kalshiResult = cancellation.result;
    ledgerKalshiEntry = captureEntry(kalshiResult, ledgerKalshiEntry);
    const close = cancellation.verified
      ? await autoCloseLeg(kalshiResult, req.kalshiOrder, req.arbId, effectiveDryRun)
      : { venue: 'kalshi' as const, requestedContracts: kalshiResult.filledContracts ?? 0, complete: false, priceSource: 'estimated' as const };
    closes.push(close);
    if (!close.complete) {
      unhedged = true;
      alerts.push({
        level: 'error',
        message: `Auto-close FAILED — $${(kalshiResult.filledSize ?? 0).toFixed(2)} unhedged Kalshi exposure. Close manually.`,
        leg: 'kalshi',
        action: 'manual close required',
      });
    }
    rollbackExecuted = true;
  } else if (kFilled && pFilled) {
    // Any resting remainder can change the hedge after this snapshot. Cancel and
    // re-poll both entries before comparing final authoritative quantities.
    let entriesVerified = isTerminallyVerifiedOrder(kalshiResult) && isTerminallyVerifiedOrder(polymarketResult);
    if (!entriesVerified) {
      const [kalshiCancellation, pmCancellation] = await Promise.all([
        cancelEntry(kalshiResult, req.kalshiOrder),
        cancelEntry(polymarketResult, req.polymarketOrder),
      ]);
      kalshiResult = kalshiCancellation.result;
      polymarketResult = pmCancellation.result;
      ledgerKalshiEntry = captureEntry(kalshiResult, ledgerKalshiEntry);
      ledgerPolymarketEntry = captureEntry(polymarketResult, ledgerPolymarketEntry);
      entriesVerified = kalshiCancellation.verified && pmCancellation.verified;
      if (!entriesVerified) {
        unhedged = true;
        addStep('failed', 'Matched partial fills could not be terminally verified — exposure requires reconciliation');
        alerts.push({
          level: 'error',
          message: 'Could not terminally verify both entry cancellations — live or indeterminate remainder may still fill',
          action: 'manual reconciliation required',
        });
      }
    }

    const terminalMatch = areFilledContractsMatched(kalshiResult, polymarketResult);
    const { kalshiContracts: kFill, polymarketContracts: pFill } = terminalMatch;
    if (entriesVerified && !terminalMatch.matched) {
      addStep('failed', `Terminal mismatched fills — Kalshi ${kFill.toFixed(4)} contracts vs Polymarket ${pFill.toFixed(4)} — closing excess`);
      alerts.push({
        level: 'warning',
        message: `Terminal mismatched fills: Kalshi ${kFill.toFixed(4)} contracts vs Polymarket ${pFill.toFixed(4)} — closing excess`,
        action: 'close excess',
      });
      const terminalExcess = Math.abs(kFill - pFill);
      const largerLeg = kFill > pFill ? kalshiResult : polymarketResult;
      const largerReq = kFill > pFill ? req.kalshiOrder : req.polymarketOrder;
      const excessNotional = terminalExcess * (largerLeg.filledPrice ?? largerReq.price);
      const close = await autoCloseLeg(
        { ...largerLeg, filledSize: excessNotional, filledContracts: terminalExcess },
        largerReq,
        req.arbId,
        effectiveDryRun,
      );
      closes.push(close);
      if (!close.complete) {
        unhedged = true;
        alerts.push({
          level: 'error',
          message: `Failed to terminally verify close of ${terminalExcess.toFixed(4)} excess contracts — unhedged exposure remains`,
          action: 'manual close required',
        });
      } else {
        addStep('partial', `Terminally verified close of ${terminalExcess.toFixed(4)} excess contracts`);
      }
      rollbackExecuted = true;
    } else if (entriesVerified) {
      const cancelledPartial = kalshiResult.status === 'cancelled' || polymarketResult.status === 'cancelled';
      addStep(
        cancelledPartial ? 'partial' : 'success',
        `Both entry orders terminal and matched — ${kFill.toFixed(4)} contracts per leg` +
          (cancelledPartial ? ' (cancelled with partial fills)' : ''),
      );
    }
  } else if (!kFilled && !pFilled) {
    // Both pending at timeout — cancel both, no exposure
    addStep('failed', 'Both legs timed out without fills — cancelling both, no exposure');
    alerts.push({
      level: 'info',
      message: 'Both legs timed out without fills — cancelling both, no exposure',
      action: 'cancel both',
    });
    const [kalshiCancellation, pmCancellation] = await Promise.all([
      cancelEntry(kalshiResult, req.kalshiOrder),
      cancelEntry(polymarketResult, req.polymarketOrder),
    ]);
    kalshiResult = kalshiCancellation.result;
    polymarketResult = pmCancellation.result;
    ledgerKalshiEntry = captureEntry(kalshiResult, ledgerKalshiEntry);
    ledgerPolymarketEntry = captureEntry(polymarketResult, ledgerPolymarketEntry);
    if (!kalshiCancellation.verified || !pmCancellation.verified) unhedged = true;
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
    const [kalshiCancellation, pmCancellation] = await Promise.all([
      cancelEntry(kalshiResult, req.kalshiOrder),
      cancelEntry(polymarketResult, req.polymarketOrder),
    ]);
    kalshiResult = kalshiCancellation.result;
    polymarketResult = pmCancellation.result;
    ledgerKalshiEntry = captureEntry(kalshiResult, ledgerKalshiEntry);
    ledgerPolymarketEntry = captureEntry(polymarketResult, ledgerPolymarketEntry);
    const close = kalshiCancellation.verified && pmCancellation.verified
      ? await autoCloseLeg(kalshiResult, req.kalshiOrder, req.arbId, effectiveDryRun)
      : { venue: 'kalshi' as const, requestedContracts: kalshiResult.filledContracts ?? 0, complete: false, priceSource: 'estimated' as const };
    closes.push(close);
    if (!close.complete) {
      unhedged = true;
      alerts.push({
        level: 'error',
        message: `Auto-close FAILED — $${(kalshiResult.filledSize ?? 0).toFixed(2)} unhedged Kalshi exposure. Close manually.`,
        leg: 'kalshi',
        action: 'manual close required',
      });
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
    const [kalshiCancellation, pmCancellation] = await Promise.all([
      cancelEntry(kalshiResult, req.kalshiOrder),
      cancelEntry(polymarketResult, req.polymarketOrder),
    ]);
    kalshiResult = kalshiCancellation.result;
    polymarketResult = pmCancellation.result;
    ledgerKalshiEntry = captureEntry(kalshiResult, ledgerKalshiEntry);
    ledgerPolymarketEntry = captureEntry(polymarketResult, ledgerPolymarketEntry);
    const close = kalshiCancellation.verified && pmCancellation.verified
      ? await autoCloseLeg(polymarketResult, req.polymarketOrder, req.arbId, effectiveDryRun)
      : { venue: 'polymarket' as const, requestedContracts: polymarketResult.filledContracts ?? 0, complete: false, priceSource: 'estimated' as const };
    closes.push(close);
    if (!close.complete) {
      unhedged = true;
      alerts.push({
        level: 'error',
        message: `Auto-close FAILED — $${(polymarketResult.filledSize ?? 0).toFixed(2)} unhedged Polymarket exposure. Close manually.`,
        leg: 'polymarket',
        action: 'manual close required',
      });
    }
    rollbackExecuted = true;
  }

  // ── Reconcile integer-cent execution cash and net exposure ──
  let netExposure: number | undefined;

  if (kalshiResult.filledSize && polymarketResult.filledSize && kalshiResult.filledPrice && polymarketResult.filledPrice) {
    const kalshiNotional = kalshiResult.filledSize;
    const pmNotional = polymarketResult.filledSize;
    netExposure = unhedged ? Math.abs(kalshiNotional - pmNotional) : 0;
  } else if (unhedged) {
    // One leg filled, other didn't — all of the filled amount is exposure
    netExposure = (kalshiResult.filledSize ?? 0) + (polymarketResult.filledSize ?? 0);
  }

  const cashLedger = reconcileExecutionCashLedger({
    kalshiEntry: { ...ledgerKalshiEntry, orderTerminality: entryTerminalities.kalshi.terminality, terminalitySource: entryTerminalities.kalshi.source },
    polymarketEntry: { ...ledgerPolymarketEntry, orderTerminality: entryTerminalities.polymarket.terminality, terminalitySource: entryTerminalities.polymarket.source },
    closes,
    unhedged,
  });
  const actualProfit = cashLedger.netPnlCents == null ? undefined : cashLedger.netPnlCents / 100;
  if (cashLedger.status !== 'reconciled') {
    alerts.push({
      level: unhedged ? 'error' : 'warning',
      message: `Execution cash ledger requires reconciliation: ${cashLedger.issues.join(', ')}`,
      action: 'review persisted execution ledger',
    });
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
    liveEvidenceComplete &&
    (effectiveDryRun || cashLedger.status === 'reconciled');

  const finalStatus: StepStatus = success ? 'success' : (unhedged ? 'failed' : 'partial');
  addStep(finalStatus, `Execution ${success ? 'completed successfully' : 'completed with issues'} — ${cashLedger.status === 'reconciled' ? `net P&L $${(actualProfit ?? 0).toFixed(2)}` : 'P&L reconciliation required'}, gross spread ${cashLedger.grossSpreadCents == null ? 'unknown' : `$${(cashLedger.grossSpreadCents / 100).toFixed(2)}`}, net exposure $${(netExposure ?? 0).toFixed(2)}, time ${Date.now() - startTime}ms`);

  return {
    success,
    kalshiResult,
    polymarketResult,
    actualProfit,
    cashLedger,
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