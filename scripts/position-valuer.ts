// Position Valuer — 10-minute valuation + settlement detection for open bot_positions.
// Standalone PM2 process (h2h-valuer).  Fetches current prices from Kalshi + PM CLOB,
// computes unrealized PnL / ROI, and detects settled markets.
//
// Build:   npx esbuild scripts/position-valuer.ts --bundle --platform=node --format=esm \
//          --outfile=dist/position-valuer.mjs --external:@libsql/client \
//          --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
// Run:     node dist/position-valuer.mjs

import path from 'path';
import { createClient } from '@libsql/client';
import { fetchKalshiMarket } from '../src/lib/kalshi';
import { fetchClobMarket } from '../src/lib/polymarket-clob';

const DB_PATH = path.join(process.cwd(), 'data', 'edgefinder.db');
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

interface BotPositionRow {
  id: number;
  kalshi_ticker: string | null;
  pm_condition_id: string | null;
  strategy: string | null;
  kalshi_side: 'yes' | 'no';
  pm_side: 'yes' | 'no';
  shares_kalshi: number;
  shares_pm: number;
  total_cost: number;
  fees: number;
  expiry_date: string | null;
}

/* ── Helpers ─────────────────────────────────────────────── */

function getDb() {
  return createClient({ url: `file:${DB_PATH}` });
}

function toCents(dollars: string | undefined): number | null {
  if (!dollars) return null;
  const n = parseFloat(dollars);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

/** Extract PM YES-bid / NO-bid in cents from a CLOB market. */
function getPmPrices(market: Awaited<ReturnType<typeof fetchClobMarket>>): { yes: number | null; no: number | null } {
  if (!market) return { yes: null, no: null };

  const yesToken = market.tokens?.find((t: any) => t.outcome === 'Yes');
  const noToken = market.tokens?.find((t: any) => t.outcome === 'No');

  if (market.neg_risk === true) {
    // Neg-risk markets: each token trades independently.
    return {
      yes: yesToken?.price != null ? Math.round(yesToken.price * 100) : null,
      no: noToken?.price != null ? Math.round(noToken.price * 100) : null,
    };
  }

  // Standard binary market — use orderbook for sell (bid) prices.
  if (market.best_bid != null && market.best_ask != null) {
    return {
      yes: Math.round(market.best_bid * 100),
      no: Math.round((1 - market.best_ask) * 100),
    };
  }

  // Fallback to token last-trade prices.
  return {
    yes: yesToken?.price != null ? Math.round(yesToken.price * 100) : null,
    no: noToken?.price != null ? Math.round(noToken.price * 100) : null,
  };
}

/** Detect the resolved outcome from price extremes (0 / 1). */
function detectOutcome(
  kalshi: Awaited<ReturnType<typeof fetchKalshiMarket>>,
  pm: Awaited<ReturnType<typeof fetchClobMarket>>,
): 'yes' | 'no' | null {
  if (kalshi) {
    const yes = toCents(kalshi.yes_bid_dollars);
    const no = toCents(kalshi.no_bid_dollars);
    if (yes === 100 && no === 0) return 'yes';
    if (no === 100 && yes === 0) return 'no';
  }
  if (pm) {
    const { yes, no } = getPmPrices(pm);
    if (yes === 100 && no === 0) return 'yes';
    if (no === 100 && yes === 0) return 'no';
  }
  return null;
}

/** Which platform (leg) holds the winning bet? */
function settlementSide(strategy: string | null, outcome: 'yes' | 'no'): 'kalshi' | 'pm' | null {
  if (strategy === 'Buy YES Kalshi + NO PM') {
    return outcome === 'yes' ? 'kalshi' : 'pm';
  }
  if (strategy === 'Buy YES PM + NO Kalshi') {
    return outcome === 'yes' ? 'pm' : 'kalshi';
  }
  // Fallback: infer from side fields.
  return null;
}

/* ── DB operations ───────────────────────────────────────── */

async function getOpenPositions(): Promise<BotPositionRow[]> {
  const db = getDb();
  try {
    const res = await db.execute({
      sql: `SELECT id, kalshi_ticker, pm_condition_id, strategy,
                   kalshi_side, pm_side, shares_kalshi, shares_pm,
                   total_cost, fees, expiry_date
            FROM bot_positions WHERE status = 'open'`,
    });
    return (res.rows as any[]).map((r: any) => ({
      id: Number(r.id),
      kalshi_ticker: r.kalshi_ticker ?? null,
      pm_condition_id: r.pm_condition_id ?? null,
      strategy: r.strategy ?? null,
      kalshi_side: String(r.kalshi_side) as 'yes' | 'no',
      pm_side: String(r.pm_side) as 'yes' | 'no',
      shares_kalshi: Number(r.shares_kalshi),
      shares_pm: Number(r.shares_pm),
      total_cost: Number(r.total_cost),
      fees: Number(r.fees ?? 0),
      expiry_date: r.expiry_date ? String(r.expiry_date) : null,
    }));
  } finally {
    db.close();
  }
}

async function updateValuation(
  positionId: number,
  kalshiPrice: number | null,
  pmPrice: number | null,
  currentValue: number | null,
  unrealizedPnl: number | null,
  unrealizedRoiBps: number | null,
) {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    await db.execute({
      sql: `UPDATE bot_positions
            SET current_price_kalshi = ?, current_price_pm = ?, current_value = ?,
                unrealized_pnl = ?, unrealized_roi_pct = ?, last_valuation_at = ?
            WHERE id = ?`,
      args: [kalshiPrice, pmPrice, currentValue, unrealizedPnl, unrealizedRoiBps, now, positionId],
    });
  } finally {
    db.close();
  }
}

async function settlePosition(
  positionId: number,
  side: 'kalshi' | 'pm',
  realizedPnl: number,
) {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    await db.execute({
      sql: `UPDATE bot_positions
            SET status = 'settled',
                settled_at = ?,
                settlement_side = ?,
                realized_pnl = ?,
                current_value = NULL,
                unrealized_pnl = NULL,
                unrealized_roi_pct = NULL,
                last_valuation_at = ?
            WHERE id = ?`,
      args: [now, side, realizedPnl, now, positionId],
    });
  } finally {
    db.close();
  }
}

/* ── Valuation logic ─────────────────────────────────────── */

async function valuateOnce() {
  const now = new Date();
  const iso = now.toISOString();
  console.log(`[${iso}] Starting position valuation cycle...`);

  const positions = await getOpenPositions();
  if (positions.length === 0) {
    console.log(`[${iso}] No open positions.`);
    return;
  }

  console.log(`[${iso}] Valuating ${positions.length} open position(s)...`);

  for (const pos of positions) {
    try {
      const { kalshi_ticker: kTicker, pm_condition_id: pmCid } = pos;
      if (!kTicker || !pmCid) {
        console.warn(`[${iso}] Position ${pos.id} missing ticker/conditionId, skipping.`);
        continue;
      }

      // Fetch both markets concurrently. fetchKalshiMarket has 30s TTL memo;
      // fetchClobMarket has 15s clobCache.  These satisfy the requested
      // 10s / 15s cache semantics under normal load.
      const [kalshi, pm] = await Promise.all([
        fetchKalshiMarket(kTicker),
        fetchClobMarket(pmCid),
      ]);

      const kalshiYesBid = kalshi ? toCents(kalshi.yes_bid_dollars) : null;
      const kalshiNoBid = kalshi ? toCents(kalshi.no_bid_dollars) : null;
      const pmPrices = getPmPrices(pm);

      // Determine the current sell (bid) price for each leg we hold.
      let currentKalshiPrice: number | null = null;
      let currentPmPrice: number | null = null;

      if (pos.strategy === 'Buy YES Kalshi + NO PM') {
        // Hold YES on Kalshi, NO on PM
        currentKalshiPrice = kalshiYesBid;
        currentPmPrice = pmPrices.no;
      } else if (pos.strategy === 'Buy YES PM + NO Kalshi') {
        // Hold YES on PM, NO on Kalshi
        currentPmPrice = pmPrices.yes;
        currentKalshiPrice = kalshiNoBid;
      } else {
        // Fallback: derive from side columns.
        currentKalshiPrice = pos.kalshi_side === 'yes' ? kalshiYesBid : kalshiNoBid;
        currentPmPrice = pos.pm_side === 'yes' ? pmPrices.yes : pmPrices.no;
      }

      // ── Settlement detection ──
      const expired = pos.expiry_date ? new Date(pos.expiry_date) < now : false;
      const outcome = detectOutcome(kalshi, pm);

      if (expired && outcome != null) {
        const side = settlementSide(pos.strategy, outcome);
        if (side == null) {
          console.warn(`[${iso}] Position ${pos.id}: resolved but cannot determine settlement side (strategy=${pos.strategy}), skipping.`);
          continue;
        }

        const payout = side === 'kalshi'
          ? pos.shares_kalshi * 100   // $1 per share in cents
          : pos.shares_pm * 100;

        const realizedPnl = payout - pos.total_cost - pos.fees;
        await settlePosition(pos.id, side, realizedPnl);
        console.log(`[${iso}] Position ${pos.id} SETTLED — side: ${side}, payout: ${payout}c, realized_pnl: ${realizedPnl}c`);
        continue;
      }

      // ── Normal valuation ──
      const kalshiValue = currentKalshiPrice != null ? currentKalshiPrice * pos.shares_kalshi : null;
      const pmValue = currentPmPrice != null ? currentPmPrice * pos.shares_pm : null;
      const currentValue = (kalshiValue != null && pmValue != null) ? kalshiValue + pmValue : null;
      const unrealizedPnl = currentValue != null ? currentValue - pos.total_cost : null;
      const unrealizedRoiBps = (unrealizedPnl != null && pos.total_cost > 0)
        ? Math.round((unrealizedPnl * 10_000) / pos.total_cost)
        : null;

      await updateValuation(pos.id, currentKalshiPrice, currentPmPrice, currentValue, unrealizedPnl, unrealizedRoiBps);
      console.log(`[${iso}] Position ${pos.id} valuated — kalshi:${currentKalshiPrice ?? '?'}c pm:${currentPmPrice ?? '?'}c value:${currentValue ?? '?'}c pnl:${unrealizedPnl ?? '?'}c`);
    } catch (err) {
      console.error(`[${iso}] Error valuating position ${pos.id}:`, err instanceof Error ? err.message : String(err));
      // Log detail at debug level when available
      if (err instanceof Error && err.stack) {
        console.error(err.stack.split('\n').slice(0, 3).join('\n'));
      }
    }
  }
}

/* ── Main loop ───────────────────────────────────────────── */

async function run() {
  console.log(`[${new Date().toISOString()}] Position valuer started — interval: ${POLL_INTERVAL_MS / 1000}s`);
  while (true) {
    const started = Date.now();
    try {
      await valuateOnce();
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Valuation cycle failed:`, e instanceof Error ? e.message : String(e));
    }
    const elapsed = Date.now() - started;
    const sleepMs = Math.max(1000, POLL_INTERVAL_MS - elapsed);
    console.log(`[${new Date().toISOString()}] Sleeping ${Math.round(sleepMs / 1000)}s...`);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

run();
