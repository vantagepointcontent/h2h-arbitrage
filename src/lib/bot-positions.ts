import path from 'node:path';
import { createClient, type Client } from '@libsql/client';

export type BotPositionStatus = 'open' | 'settled' | 'closed';
export type BotPositionSide = 'yes' | 'no';
export type SettlementSide = 'kalshi' | 'pm' | null;

export interface BotPosition {
  id: number;
  executionId: number;
  marketId: string | null;
  marketTitle: string;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  strategy: string | null;
  kalshiSide: BotPositionSide;
  pmSide: BotPositionSide;
  buyPriceKalshiCents: number;
  buyPricePmCents: number;
  sharesKalshi: number;
  sharesPm: number;
  totalCostCents: number;
  expectedPayoutCents: number;
  expectedProfitCents: number;
  feesCents: number;
  status: BotPositionStatus;
  openedAt: string;
  expiryDate: string | null;
  settledAt: string | null;
  currentPriceKalshiCents: number | null;
  currentPricePmCents: number | null;
  currentValueCents: number | null;
  unrealizedPnlCents: number | null;
  unrealizedRoiBps: number | null;
  lastValuationAt: string | null;
  realizedPnlCents: number | null;
  settlementSide: SettlementSide;
  dryRun: boolean;
}

function getClient(): Client {
  return createClient({ url: `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}` });
}

function rowToPosition(row: Record<string, unknown>): BotPosition {
  return {
    id: Number(row.id),
    executionId: Number(row.execution_id),
    marketId: row.market_id != null ? String(row.market_id) : null,
    marketTitle: String(row.market_title),
    kalshiTicker: row.kalshi_ticker != null ? String(row.kalshi_ticker) : null,
    pmConditionId: row.pm_condition_id != null ? String(row.pm_condition_id) : null,
    strategy: row.strategy != null ? String(row.strategy) : null,
    kalshiSide: String(row.kalshi_side) as BotPositionSide,
    pmSide: String(row.pm_side) as BotPositionSide,
    buyPriceKalshiCents: Number(row.buy_price_kalshi),
    buyPricePmCents: Number(row.buy_price_pm),
    sharesKalshi: Number(row.shares_kalshi),
    sharesPm: Number(row.shares_pm),
    totalCostCents: Number(row.total_cost),
    expectedPayoutCents: Number(row.expected_payout),
    expectedProfitCents: Number(row.expected_profit),
    feesCents: Number(row.fees ?? 0),
    status: String(row.status) as BotPositionStatus,
    openedAt: String(row.opened_at),
    expiryDate: row.expiry_date != null ? String(row.expiry_date) : null,
    settledAt: row.settled_at != null ? String(row.settled_at) : null,
    currentPriceKalshiCents: row.current_price_kalshi != null ? Number(row.current_price_kalshi) : null,
    currentPricePmCents: row.current_price_pm != null ? Number(row.current_price_pm) : null,
    currentValueCents: row.current_value != null ? Number(row.current_value) : null,
    unrealizedPnlCents: row.unrealized_pnl != null ? Number(row.unrealized_pnl) : null,
    unrealizedRoiBps: row.unrealized_roi_pct != null ? Number(row.unrealized_roi_pct) : null,
    lastValuationAt: row.last_valuation_at != null ? String(row.last_valuation_at) : null,
    realizedPnlCents: row.realized_pnl != null ? Number(row.realized_pnl) : null,
    settlementSide: row.settlement_side != null ? String(row.settlement_side) as SettlementSide : null,
    dryRun: Boolean(Number(row.dry_run ?? 1)),
  };
}

export async function getBotPositions(options: { status?: BotPositionStatus | 'all'; limit?: number } = {}): Promise<BotPosition[]> {
  const c = getClient();
  try {
    const status = options.status ?? 'all';
    if (status !== 'all' && status !== 'open' && status !== 'settled') {
      throw new Error(`Invalid status: ${status}`);
    }
    const limit = Math.min(1000, Math.max(1, options.limit ?? 100));
    const where = status === 'all' ? '' : "WHERE bp.status = ?";
    const args = status === 'all' ? [limit] : [status, limit];
    const res = await c.execute({
      sql: `SELECT bp.*, COALESCE(e.dry_run, 1) AS dry_run
            FROM bot_positions bp
            LEFT JOIN executions e ON e.id = bp.execution_id
            ${where}
            ORDER BY bp.opened_at DESC
            LIMIT ?`,
      args,
    });
    return (res.rows as Array<Record<string, unknown>>).map(rowToPosition);
  } finally {
    c.close();
  }
}

export interface BotPositionAnalytics {
  totalBotTrades: { paper: number; production: number; total: number };
  openPositions: { count: number; unrealizedPnlCents: number };
  settledPositions: { count: number; realizedPnlCents: number; winRateBps: number };
  averageRoi: { atTradeBps: number; currentBps: number };
  bestTrade: BotPosition | null;
  worstTrade: BotPosition | null;
  dailyPnl: Array<{ date: string; realizedPnlCents: number; unrealizedPnlCents: number; trades: number }>;
  timeStats: { tradesPerDayBps: number; averageHoldSeconds: number };
}

function roiBps(pnlCents: number, costCents: number): number {
  if (costCents <= 0) return 0;
  return Math.round((pnlCents * 10_000) / costCents);
}

export async function getBotPositionAnalytics(): Promise<BotPositionAnalytics> {
  const c = getClient();
  try {
    const res = await c.execute({
      sql: `SELECT bp.*, COALESCE(e.dry_run, 1) AS dry_run
            FROM bot_positions bp
            LEFT JOIN executions e ON e.id = bp.execution_id
            ORDER BY bp.opened_at DESC`,
    });
    const positions = (res.rows as Array<Record<string, unknown>>).map(rowToPosition);

    const paper = positions.filter((p) => p.dryRun).length;
    const production = positions.length - paper;
    const open = positions.filter((p) => p.status === 'open');
    const settled = positions.filter((p) => p.status === 'settled');

    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

    const score = (p: BotPosition) => p.realizedPnlCents ?? p.unrealizedPnlCents ?? 0;
    const ranked = [...positions].sort((a, b) => score(b) - score(a));

    const dates = new Map<string, { realizedPnlCents: number; unrealizedPnlCents: number; trades: number }>();
    for (const p of positions) {
      const date = p.openedAt.slice(0, 10);
      const row = dates.get(date) ?? { realizedPnlCents: 0, unrealizedPnlCents: 0, trades: 0 };
      row.trades += 1;
      row.realizedPnlCents += p.realizedPnlCents ?? 0;
      row.unrealizedPnlCents += p.status === 'open' ? (p.unrealizedPnlCents ?? 0) : 0;
      dates.set(date, row);
    }
    const distinctDays = Math.max(1, dates.size);

    const holdSeconds = settled.map((p) => {
      const start = Date.parse(p.openedAt);
      const end = p.settledAt ? Date.parse(p.settledAt) : start;
      return Math.max(0, Math.round((end - start) / 1000));
    });

    return {
      totalBotTrades: { paper, production, total: positions.length },
      openPositions: {
        count: open.length,
        unrealizedPnlCents: sum(open.map((p) => p.unrealizedPnlCents ?? 0)),
      },
      settledPositions: {
        count: settled.length,
        realizedPnlCents: sum(settled.map((p) => p.realizedPnlCents ?? 0)),
        winRateBps: settled.length === 0
          ? 0
          : Math.round(settled.filter((p) => (p.realizedPnlCents ?? 0) > 0).length * 10_000 / settled.length),
      },
      averageRoi: {
        atTradeBps: positions.length === 0
          ? 0
          : Math.round(sum(positions.map((p) => roiBps(p.expectedProfitCents, p.totalCostCents))) / positions.length),
        currentBps: positions.length === 0
          ? 0
          : Math.round(sum(positions.map((p) => p.unrealizedRoiBps ?? 0)) / positions.length),
      },
      bestTrade: ranked[0] ?? null,
      worstTrade: ranked.at(-1) ?? null,
      dailyPnl: [...dates.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, values]) => ({ date, ...values })),
      timeStats: {
        tradesPerDayBps: Math.round(positions.length * 10_000 / distinctDays),
        averageHoldSeconds: holdSeconds.length === 0 ? 0 : Math.round(sum(holdSeconds) / holdSeconds.length),
      },
    };
  } finally {
    c.close();
  }
}
