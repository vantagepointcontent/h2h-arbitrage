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
import { fetchKalshiMarket, fetchKalshiMarketFast } from '../src/lib/kalshi';
import { fetchClobMarket, getClobBidPrices } from '../src/lib/polymarket-clob';
import { normalizeKalshiResolution, normalizePolymarketResolution } from '../src/lib/settlement-resolution';
import { calcKalshiFee, calcPolymarketFee } from '../src/lib/matcher';

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
  category: string | null;
  pm_theta: number | null;
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
  const cents = Math.round(n * 100);
  return Number.isFinite(cents) && cents >= 0 && cents <= 100 ? cents : null;
}

function isPriceCents(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100;
}

/** Authoritative resolution from Kalshi metadata (independent of empty books). */
function getKalshiResolutionPrices(market: Awaited<ReturnType<typeof fetchKalshiMarket>>): {
  yesBidCents: number | null;
  noBidCents: number | null;
  resolved: boolean;
} {
  if (!market) return { yesBidCents: null, noBidCents: null, resolved: false };
  const resolution = normalizeKalshiResolution(market);
  return resolution.verified
    ? { yesBidCents: resolution.yesPayoutCents, noBidCents: resolution.noPayoutCents, resolved: true }
    : { yesBidCents: null, noBidCents: null, resolved: false };
}

/** Authoritative resolution from Polymarket metadata (independent of empty books). */
function getPmResolutionPrices(market: Awaited<ReturnType<typeof fetchClobMarket>>): {
  yesBidCents: number | null;
  noBidCents: number | null;
  resolved: boolean;
} {
  if (!market) return { yesBidCents: null, noBidCents: null, resolved: false };
  const resolution = normalizePolymarketResolution(market);
  return resolution.verified
    ? { yesBidCents: resolution.yesPayoutCents, noBidCents: resolution.noPayoutCents, resolved: true }
    : { yesBidCents: null, noBidCents: null, resolved: false };
}

/** Extract executable PM sell (bid) prices using depth-aware token orderbooks. */
async function getPmExecutablePrices(pmCid: string): Promise<{
  yes: number | null;
  no: number | null;
  resolved: boolean;
  observedAt: string;
}> {
  const market = await fetchClobMarket(pmCid);
  if (!market) return { yes: null, no: null, resolved: false, observedAt: new Date().toISOString() };

  // Check authoritative settlement first (before requiring live books).
  const resolution = getPmResolutionPrices(market);
  if (resolution.resolved) {
    return { yes: resolution.yesBidCents, no: resolution.noBidCents, resolved: true, observedAt: new Date().toISOString() };
  }

  // Use depth-aware token orderbooks for executable prices.
  const bids = await getClobBidPrices(market);
  return {
    yes: bids.yesBidCents,
    no: bids.noBidCents,
    resolved: false,
    observedAt: new Date().toISOString(),
  };
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
                   total_cost, fees, category, pm_theta, expiry_date
            FROM bot_positions WHERE status = 'open'`,
    });
    return res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
      id: Number(r.id),
      kalshi_ticker: r.kalshi_ticker != null ? String(r.kalshi_ticker) : null,
      pm_condition_id: r.pm_condition_id != null ? String(r.pm_condition_id) : null,
      strategy: r.strategy != null ? String(r.strategy) : null,
      kalshi_side: String(r.kalshi_side) as 'yes' | 'no',
      pm_side: String(r.pm_side) as 'yes' | 'no',
      shares_kalshi: Number(r.shares_kalshi),
      shares_pm: Number(r.shares_pm),
      total_cost: Number(r.total_cost),
      fees: Number(r.fees ?? 0),
      category: r.category ? String(r.category) : null,
      pm_theta: r.pm_theta != null ? Number(r.pm_theta) : null,
      expiry_date: r.expiry_date ? String(r.expiry_date) : null,
      };
    });
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
  observedAt: string,
) {
  const db = getDb();
  try {
    await db.execute({
      sql: `UPDATE bot_positions
            SET current_price_kalshi = ?, current_price_pm = ?, current_value = ?,
                unrealized_pnl = ?, unrealized_roi_pct = ?, last_valuation_at = ?
            WHERE id = ?`,
      args: [kalshiPrice, pmPrice, currentValue, unrealizedPnl, unrealizedRoiBps, observedAt, positionId],
    });
  } finally {
    db.close();
  }
}

async function settlePosition(
  positionId: number,
  side: 'kalshi' | 'pm',
  realizedPnl: number,
  settledAt: string,
) {
  const db = getDb();
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
      args: [settledAt, side, realizedPnl, settledAt, positionId],
    });
  } finally {
    db.close();
  }
}

function roiBps(pnlCents: number, costCents: number): number {
  if (costCents <= 0) return 0;
  return Math.round((pnlCents * 10_000) / costCents);
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

      // ── Phase 0: Authoritative settlement check (no orderbook required) ──
      const kalshiSettlement = await fetchKalshiMarketFast(kTicker);
      const kalshiResolution = getKalshiResolutionPrices(kalshiSettlement);

      const pmExecutable = await getPmExecutablePrices(pmCid);

      const kalshiResolved = kalshiResolution.resolved;
      const pmResolved = pmExecutable.resolved;

      // Determine prices: settlement prices take precedence over live bids.
      const kalshiYesBid = kalshiResolved ? kalshiResolution.yesBidCents : toCents(kalshiSettlement?.yes_bid_dollars);
      const kalshiNoBid = kalshiResolved ? kalshiResolution.noBidCents : toCents(kalshiSettlement?.no_bid_dollars);

      const pmYesBid = pmResolved ? pmExecutable.yes : pmExecutable.yes;
      const pmNoBid = pmResolved ? pmExecutable.no : pmExecutable.no;

      // Determine the current sell (bid) price for each leg we hold.
      let currentKalshiPrice: number | null = null;
      let currentPmPrice: number | null = null;

      if (pos.strategy === 'Buy YES Kalshi + NO PM') {
        currentKalshiPrice = kalshiYesBid;
        currentPmPrice = pmNoBid;
      } else if (pos.strategy === 'Buy YES PM + NO Kalshi') {
        currentPmPrice = pmYesBid;
        currentKalshiPrice = kalshiNoBid;
      } else {
        currentKalshiPrice = pos.kalshi_side === 'yes' ? kalshiYesBid : kalshiNoBid;
        currentPmPrice = pos.pm_side === 'yes' ? pmYesBid : pmNoBid;
      }

      // ── Settlement detection ──
      const expired = pos.expiry_date ? new Date(pos.expiry_date) < now : false;
      const resolvedComplement =
        (kalshiYesBid === 100 && kalshiNoBid === 0 && pmYesBid === 100 && pmNoBid === 0) ||
        (kalshiNoBid === 100 && kalshiYesBid === 0 && pmNoBid === 100 && pmYesBid === 0);

      if (expired && kalshiResolved && pmResolved && resolvedComplement) {
        const outcome = kalshiYesBid === 100 ? 'yes' : 'no';
        const side = settlementSide(pos.strategy, outcome);
        if (side == null) {
          console.warn(`[${iso}] Position ${pos.id}: resolved but cannot determine settlement side (strategy=${pos.strategy}), skipping.`);
          continue;
        }

        const payoutCents = side === 'kalshi'
          ? pos.shares_kalshi * 100
          : pos.shares_pm * 100;

        // total_cost already INCLUDES entry fees; do NOT subtract fees again.
        const realizedPnl = payoutCents - pos.total_cost;
        await settlePosition(pos.id, side, realizedPnl, iso);
        console.log(`[${iso}] Position ${pos.id} SETTLED — side: ${side}, payout: ${payoutCents}c, realized_pnl: ${realizedPnl}c`);
        continue;
      }

      // ── Normal valuation (fee-net, using depth-aware executable prices) ──
      if (!isPriceCents(currentKalshiPrice) || !isPriceCents(currentPmPrice)) {
        console.warn(`[${iso}] Position ${pos.id}: missing executable bid (kalshi:${currentKalshiPrice ?? '?'} pm:${currentPmPrice ?? '?'}), skipping valuation.`);
        continue;
      }

      if (pos.pm_theta == null || !Number.isFinite(pos.pm_theta)) {
        console.warn(`[${iso}] Position ${pos.id}: missing authoritative Polymarket theta, skipping valuation.`);
        continue;
      }

      const kalshiExitFeeCents = Math.round(calcKalshiFee(pos.shares_kalshi, currentKalshiPrice / 100) * 100);
      const pmExitFeeCents = Math.round(calcPolymarketFee(pos.shares_pm, currentPmPrice / 100, pos.pm_theta) * 100);
      const currentValueCents =
        currentKalshiPrice * pos.shares_kalshi + currentPmPrice * pos.shares_pm - kalshiExitFeeCents - pmExitFeeCents;
      const unrealizedPnlCents = currentValueCents - pos.total_cost;
      const unrealizedRoiBps = roiBps(unrealizedPnlCents, pos.total_cost);

      // Use the freshest observation timestamp
      const observedAt = pmExecutable.observedAt;

      await updateValuation(
        pos.id, currentKalshiPrice, currentPmPrice,
        currentValueCents, unrealizedPnlCents, unrealizedRoiBps,
        observedAt,
      );
      console.log(`[${iso}] Position ${pos.id} valuated — kalshi:${currentKalshiPrice}c pm:${currentPmPrice}c value:${currentValueCents}c pnl:${unrealizedPnlCents}c`);
    } catch (err) {
      console.error(`[${iso}] Error valuating position ${pos.id}:`, err instanceof Error ? err.message : String(err));
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
