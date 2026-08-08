const TIMEZONE = 'America/New_York';

type Platform = 'kalshi' | 'polymarket';

interface ExecutionLike {
  timestamp: string;
  dryRun: boolean;
  success: boolean;
  kalshiOrder?: unknown;
  polymarketOrder?: unknown;
  result?: unknown;
}

interface ClosedPositionLike {
  closedAt: string;
  platform: Platform;
  realizedPnl: number;
  size: number;
  entryPrice: number;
  pairId?: string | null;
}

interface PositionLike {
  breakdown?: { totalNetPnl?: number } | null;
}

function easternDateKey(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Persisted order size is USD stake, not contract count. */
function orderVolume(order: unknown): number {
  if (!order || typeof order !== 'object') return 0;
  const value = order as Record<string, unknown>;
  const size = Number(value.size ?? 0);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/** Prefer the actual filled USD stake recorded by the execution engine. */
function executionLegVolume(entry: ExecutionLike, platform: Platform): number {
  const result = entry.result && typeof entry.result === 'object'
    ? entry.result as Record<string, unknown>
    : null;
  const resultKey = platform === 'kalshi' ? 'kalshiResult' : 'polymarketResult';
  const leg = result?.[resultKey];
  if (leg && typeof leg === 'object') {
    const filledSize = Number((leg as Record<string, unknown>).filledSize ?? 0);
    return Number.isFinite(filledSize) && filledSize > 0 ? filledSize : 0;
  }
  return orderVolume(platform === 'kalshi' ? entry.kalshiOrder : entry.polymarketOrder);
}

const finite = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function summarizeDailyPnl({
  now = new Date(),
  executions,
  closedPositions,
  positions,
}: {
  now?: Date;
  executions: ExecutionLike[];
  closedPositions: ClosedPositionLike[];
  positions: PositionLike[];
}) {
  const date = easternDateKey(now);
  const liveExecutions = executions.filter((entry) =>
    !entry.dryRun && entry.success && easternDateKey(entry.timestamp) === date,
  );
  const closedToday = closedPositions.filter((entry) => easternDateKey(entry.closedAt) === date);

  const platforms = {
    kalshi: { realizedPnl: 0, volume: 0 },
    polymarket: { realizedPnl: 0, volume: 0 },
  };
  for (const entry of liveExecutions) {
    platforms.kalshi.volume += executionLegVolume(entry, 'kalshi');
    platforms.polymarket.volume += executionLegVolume(entry, 'polymarket');
  }
  for (const entry of closedToday) {
    platforms[entry.platform].realizedPnl += finite(entry.realizedPnl);
  }

  const realizedPnl = closedToday.reduce((sum, entry) => sum + finite(entry.realizedPnl), 0);
  const unrealizedPnl = positions.reduce((sum, entry) => sum + finite(entry.breakdown?.totalNetPnl), 0);
  const closedTrades = new Map<string, number>();
  closedToday.forEach((entry, index) => {
    // Legs sharing pairId are one trade. Unpaired positions remain individual trades.
    const key = entry.pairId ? `pair:${entry.pairId}` : `leg:${index}`;
    closedTrades.set(key, (closedTrades.get(key) ?? 0) + finite(entry.realizedPnl));
  });
  const wins = [...closedTrades.values()].filter((netPnl) => netPnl > 0).length;
  const totalVolume = platforms.kalshi.volume + platforms.polymarket.volume;

  return {
    date,
    timezone: TIMEZONE,
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    totalTrades: liveExecutions.length,
    winRatePct: closedTrades.size ? (wins / closedTrades.size) * 100 : 0,
    totalVolume,
    platforms,
  };
}
