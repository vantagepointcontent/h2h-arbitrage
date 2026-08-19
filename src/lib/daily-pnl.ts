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
  realizedPnl: number | null;
  size: number | null;
  entryPrice: number;
  pairId?: string | null;
}

interface PositionLike {
  breakdown?: { totalNetPnl?: number | null } | null;
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

  const platforms: Record<Platform, { realizedPnl: number | null; volume: number }> = {
    kalshi: { realizedPnl: 0, volume: 0 },
    polymarket: { realizedPnl: 0, volume: 0 },
  };
  for (const entry of liveExecutions) {
    platforms.kalshi.volume += executionLegVolume(entry, 'kalshi');
    platforms.polymarket.volume += executionLegVolume(entry, 'polymarket');
  }
  for (const platform of ['kalshi', 'polymarket'] as const) {
    const platformRows = closedToday.filter((entry) => entry.platform === platform);
    platforms[platform].realizedPnl = platformRows.some((entry) => entry.realizedPnl == null)
      ? null
      : platformRows.reduce((sum, entry) => sum + finite(entry.realizedPnl), 0);
  }

  const unavailableClosedPositions = closedToday.filter((entry) => entry.realizedPnl == null).length;
  const realizedPnl = unavailableClosedPositions > 0
    ? null
    : closedToday.reduce((sum, entry) => sum + finite(entry.realizedPnl), 0);
  const unrealizedPnl = positions.some((entry) => entry.breakdown?.totalNetPnl == null)
    ? null
    : positions.reduce((sum, entry) => sum + finite(entry.breakdown?.totalNetPnl), 0);
  const closedTrades = new Map<string, Array<number | null>>();
  closedToday.forEach((entry, index) => {
    // Legs sharing pairId are one trade. Unpaired positions remain individual trades.
    const key = entry.pairId ? `pair:${entry.pairId}` : `leg:${index}`;
    closedTrades.set(key, [...(closedTrades.get(key) ?? []), entry.realizedPnl]);
  });
  const verifiedClosedTrades = [...closedTrades.values()]
    .filter((legs) => legs.every((value) => value != null))
    .map((legs) => legs.reduce((sum, value) => sum + finite(value), 0));
  const wins = verifiedClosedTrades.filter((netPnl) => netPnl > 0).length;
  const totalVolume = platforms.kalshi.volume + platforms.polymarket.volume;

  return {
    date,
    timezone: TIMEZONE,
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl == null || unrealizedPnl == null ? null : realizedPnl + unrealizedPnl,
    totalTrades: liveExecutions.length,
    winRatePct: closedTrades.size === 0 ? 0 : verifiedClosedTrades.length ? (wins / verifiedClosedTrades.length) * 100 : null,
    verifiedClosedTrades: verifiedClosedTrades.length,
    unavailableClosedPositions,
    totalVolume,
    platforms,
  };
}
