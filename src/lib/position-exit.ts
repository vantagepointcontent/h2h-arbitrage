/**
 * Position exit logic — close both legs of an arb pair simultaneously.
 *
 * Shared by:
 *   - POST /api/positions/[id]/exit   (dedicated REST endpoint)
 *   - POST /api/positions             (legacy action:'exit' — delegates here)
 *
 * Responsibilities:
 *   1. Place SELL orders on both legs at the same time (Promise.allSettled).
 *   2. Retry a failed leg up to MAX_RETRIES times with backoff.
 *   3. If one leg closes and the other can't after retries → Telegram alert
 *      (operator must intervene; the position is partially exposed).
 *   4. Compute realized P&L net of entry + exit fees for both legs.
 *   5. Persist the exit to the executions table (audit trail) and to
 *      closed_positions (trade history with full P&L).
 *   6. Return a structured result the caller can forward to the client.
 *
 * SAFETY: kill switch is enforced by the caller (the API route), NOT here.
 * This module is only reachable through an explicit user action.
 */
import logger from './logger';
import { calcKalshiFee, calcPolymarketFee, getPolymarketTheta } from './matcher';
import { persistExecution, persistClosedPosition } from './persistence';

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1500;

// ── Types ──

export interface ExitLegRequest {
  /** Kalshi leg */
  kalshi?: {
    ticker: string;
    side: 'YES' | 'NO';
    size: number;
    /** Limit price in CENTS (1-99) */
    priceCents: number;
    /** Gross unrealized P&L from the position DTO (USD) */
    unrealizedPnl: number;
    /** Avg entry price 0-1 */
    entryPrice: number;
    title: string;
  };
  /** Polymarket leg */
  polymarket?: {
    asset: string;           // token ID
    conditionId: string;
    outcome: string;         // "Yes" | "No"
    size: number;
    /** Limit price 0-1 */
    price: number;
    /** Gross cash P&L from the position DTO (USD) */
    cashPnl: number;
    /** Avg entry price 0-1 */
    entryPrice: number;
    title: string;
  };
}

export interface ExitResult {
  /** True only if BOTH legs closed successfully. */
  success: boolean;
  /** True if one leg closed and the other failed after retries. */
  partialFill: boolean;
  /** Which leg is still open, when partialFill is true. */
  stuckLeg?: 'kalshi' | 'polymarket';
  results: {
    kalshi?: KalshiLegResult;
    polymarket?: PmLegResult;
  };
  errors: {
    kalshi?: string;
    polymarket?: string;
  };
  /** Realized P&L net of fees (USD). Computed from fill prices. */
  realizedPnlNet: number;
  /** Realized P&L gross (before exit fees). */
  realizedPnlGross: number;
  /** Total fees paid: entry fees (already in cost basis) + exit fees. */
  totalFees: number;
}

interface KalshiLegResult {
  orderId: string;
  status: string;
  filledCount: number;
}

interface PmLegResult {
  orderId: string;
  status: string;
}

// ── Public API ──

/**
 * Execute an exit: close both legs of an arb pair simultaneously.
 *
 * Caller MUST verify the kill switch is OFF before invoking.
 */
export async function executeExit(req: ExitLegRequest): Promise<ExitResult> {
  const results: ExitResult['results'] = {};
  const errors: ExitResult['errors'] = {};
  let kalshiFilled = false;
  let pmFilled = false;

  // Close both legs concurrently. Each leg retries independently.
  const tasks: Promise<void>[] = [];

  if (req.kalshi) {
    tasks.push(
      closeKalshiLeg(req.kalshi)
        .then(r => {
          results.kalshi = r;
          kalshiFilled = true;
          logger.info('[position-exit] Kalshi leg closed', {
            ticker: req.kalshi!.ticker,
            orderId: r.orderId,
            filled: r.filledCount,
          });
        })
        .catch(e => {
          errors.kalshi = e instanceof Error ? e.message : String(e);
          logger.error('[position-exit] Kalshi leg failed after retries', {
            ticker: req.kalshi!.ticker,
            error: errors.kalshi,
          });
        }),
    );
  }

  if (req.polymarket) {
    tasks.push(
      closePmLeg(req.polymarket)
        .then(r => {
          results.polymarket = r;
          pmFilled = true;
          logger.info('[position-exit] Polymarket leg closed', {
            asset: req.polymarket!.asset,
            orderId: r.orderId,
          });
        })
        .catch(e => {
          errors.polymarket = e instanceof Error ? e.message : String(e);
          logger.error('[position-exit] Polymarket leg failed after retries', {
            asset: req.polymarket!.asset,
            error: errors.polymarket,
          });
        }),
    );
  }

  await Promise.allSettled(tasks);

  const success = kalshiFilled && pmFilled;
  const partialFill =
    (!kalshiFilled && pmFilled) || (kalshiFilled && !pmFilled);
  const stuckLeg = partialFill
    ? !kalshiFilled
      ? 'kalshi'
      : 'polymarket'
    : undefined;

  // Compute realized P&L net of fees.
  const pnl = computeRealizedPnl(req, results, kalshiFilled, pmFilled);

  // Alert on partial fill: one leg is still exposed.
  if (partialFill) {
    await alertPartialFill(req, errors, stuckLeg, pnl).catch(e =>
      logger.warn('[position-exit] alert failed', { error: String(e) }),
    );
  }

  // Persist to executions table (audit trail) + closed_positions (history).
  await persistExitRecord(req, results, errors, success, partialFill, pnl).catch(e =>
    logger.warn('[position-exit] persist failed', { error: String(e) }),
  );

  return {
    success,
    partialFill,
    stuckLeg,
    results,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
    realizedPnlNet: pnl.net,
    realizedPnlGross: pnl.gross,
    totalFees: pnl.fees,
  };
}

// ── Leg closing with retry ──

async function closeKalshiLeg(
  leg: NonNullable<ExitLegRequest['kalshi']>,
): Promise<KalshiLegResult> {
  const { placeKalshiSellOrder } = await import('./kalshi-orders');
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await placeKalshiSellOrder({
        ticker: leg.ticker,
        side: leg.side === 'YES' ? 'yes' : 'no',
        count: Math.floor(leg.size),
        priceCents: Math.round(leg.priceCents),
        clientOrderId: `exit-${Date.now()}-${attempt}-kalshi`,
      });
      return { orderId: r.orderId, status: r.status, filledCount: r.filledCount };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastErr;
}

async function closePmLeg(
  leg: NonNullable<ExitLegRequest['polymarket']>,
): Promise<PmLegResult> {
  const { placePmSellOrder } = await import('./polymarket-orders');
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await placePmSellOrder({
        tokenId: leg.asset,
        price: leg.price,
        size: leg.size,
      });
      return { orderId: r.orderId, status: r.status };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastErr;
}

// ── P&L computation (net of fees) ──

function computeRealizedPnl(
  req: ExitLegRequest,
  results: ExitResult['results'],
  kalshiFilled: boolean,
  pmFilled: boolean,
): { gross: number; net: number; fees: number } {
  let gross = 0;
  let fees = 0;

  if (req.kalshi && kalshiFilled) {
    const size = Math.floor(req.kalshi.size);
    const exitPrice = req.kalshi.priceCents / 100;
    // Gross P&L = (exit - entry) * size; cost basis already includes entry fees.
    gross += (exitPrice - req.kalshi.entryPrice) * size;
    // Exit fees on the sell side.
    fees += calcKalshiFee(size, exitPrice);
  }

  if (req.polymarket && pmFilled) {
    const theta = getPolymarketTheta();
    const exitPrice = req.polymarket.price;
    gross += (exitPrice - req.polymarket.entryPrice) * req.polymarket.size;
    fees += calcPolymarketFee(req.polymarket.size, exitPrice, theta);
  }

  return { gross, net: gross - fees, fees };
}

// ── Persistence ──

async function persistExitRecord(
  req: ExitLegRequest,
  results: ExitResult['results'],
  errors: ExitResult['errors'],
  success: boolean,
  partialFill: boolean,
  pnl: { gross: number; net: number; fees: number },
): Promise<void> {
  const marketTitle = req.kalshi?.title ?? req.polymarket?.title ?? 'Unknown';
  const pairId = `exit-${Date.now()}`;
  const now = new Date().toISOString();

  // 1. Audit row in executions table.
  await persistExecution({
    timestamp: now,
    arbId: pairId,
    marketTitle,
    dryRun: false,
    success,
    strategy: 'manual-exit',
    kalshiOrder: req.kalshi
      ? {
          ticker: req.kalshi.ticker,
          outcome: req.kalshi.side,
          side: 'sell',
          size: req.kalshi.size,
          price: req.kalshi.priceCents / 100,
          platform: 'kalshi',
        }
      : null,
    polymarketOrder: req.polymarket
      ? {
          outcome: req.polymarket.outcome,
          side: 'sell',
          size: req.polymarket.size,
          price: req.polymarket.price,
          platform: 'polymarket',
          conditionId: req.polymarket.conditionId,
        }
      : null,
    result: {
      kalshiResult: results.kalshi
        ? {
            status: results.kalshi.status,
            orderId: results.kalshi.orderId,
            filledSize: results.kalshi.filledCount,
          }
        : undefined,
      polymarketResult: results.polymarket
        ? {
            status: results.polymarket.status,
            orderId: results.polymarket.orderId,
          }
        : undefined,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
      realizedPnlNet: pnl.net,
      realizedPnlGross: pnl.gross,
      fees: pnl.fees,
    },
    estimatedProfit: pnl.net,
  });

  // 2. Closed-position rows for trade history (one per leg that filled).
  if (req.kalshi && results.kalshi) {
    const size = Math.floor(req.kalshi.size);
    const exitPrice = req.kalshi.priceCents / 100;
    const entryFees = calcKalshiFee(size, req.kalshi.entryPrice);
    const exitFees = calcKalshiFee(size, exitPrice);
    const legGross = (exitPrice - req.kalshi.entryPrice) * size;
    const legNet = legGross - exitFees;
    const cost = req.kalshi.entryPrice * size;
    await persistClosedPosition({
      marketTitle,
      platform: 'kalshi',
      side: req.kalshi.side,
      size,
      entryPrice: req.kalshi.entryPrice,
      exitPrice,
      realizedPnl: legNet,
      roiPct: cost > 0 ? (legNet / cost) * 100 : 0,
      closedAt: now,
      pairId,
      feesPaid: entryFees + exitFees,
      ticker: req.kalshi.ticker,
      rawData: { orderId: results.kalshi.orderId, status: results.kalshi.status },
    });
  }

  if (req.polymarket && results.polymarket) {
    const theta = getPolymarketTheta();
    const exitPrice = req.polymarket.price;
    const entryFees = calcPolymarketFee(req.polymarket.size, req.polymarket.entryPrice, theta);
    const exitFees = calcPolymarketFee(req.polymarket.size, exitPrice, theta);
    const legGross = (exitPrice - req.polymarket.entryPrice) * req.polymarket.size;
    const legNet = legGross - exitFees;
    const cost = req.polymarket.entryPrice * req.polymarket.size;
    await persistClosedPosition({
      marketTitle,
      platform: 'polymarket',
      side: req.polymarket.outcome.toLowerCase() === 'yes' ? 'YES' : 'NO',
      size: req.polymarket.size,
      entryPrice: req.polymarket.entryPrice,
      exitPrice,
      realizedPnl: legNet,
      roiPct: cost > 0 ? (legNet / cost) * 100 : 0,
      closedAt: now,
      pairId,
      feesPaid: entryFees + exitFees,
      conditionId: req.polymarket.conditionId,
      rawData: { orderId: results.polymarket.orderId, status: results.polymarket.status },
    });
  }
}

// ── Telegram alert on partial fill ──

async function alertPartialFill(
  req: ExitLegRequest,
  errors: ExitResult['errors'],
  stuckLeg: 'kalshi' | 'polymarket' | undefined,
  pnl: { gross: number; net: number; fees: number },
): Promise<void> {
  const { getConfigResolved, isPausedResolved, sendTelegramMessage } = await import(
    './telegram-alerts'
  );
  const config = await getConfigResolved();
  if (!config) return; // not configured
  if (await isPausedResolved()) return;

  const market = req.kalshi?.title ?? req.polymarket?.title ?? 'Unknown';
  const stuck = stuckLeg === 'kalshi' ? 'Kalshi' : 'Polymarket';
  const err = stuckLeg === 'kalshi' ? errors.kalshi : errors.polymarket;
  const msg =
    `⚠️ <b>Partial Exit — Manual Intervention Needed</b>\n` +
    `Market: <b>${escapeHtml(market)}</b>\n` +
    `Stuck leg: <b>${stuck}</b> — ${escapeHtml(err ?? 'unknown error')}\n` +
    `Realized P&amp;L so far: $${pnl.net.toFixed(2)} (net of fees)\n` +
    `The ${stuck} position is still open. Retry the exit or close it manually.`;

  await sendTelegramMessage(config.botToken, config.chatId, msg);
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}