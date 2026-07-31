const TIMEZONE = 'America/New_York';

type Platform = 'kalshi' | 'polymarket';

interface ExecutionLike {
  timestamp: string;
  dryRun: boolean;
  success: boolean;
  kalshiOrder?: unknown;
  polymarketOrder?: unknown;
}

interface ClosedPositionLike {
  closedAt: string;
  platform: Platform;
  realizedPnl: number;
  size: number;
  entryPrice: number;
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

function orderVolume(order: unknown): number {
  if (!order || typeof order !== 'object') return 0;
  const value = order as Record<string, unknown>;
  const size = Number(value.size ?? 0);
  const price = Number(value.price ?? 0);
  return Number.isFinite(size) && Number.isFinite(price) && size > 0 && price > 0 ? size * price : 0;
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
    platforms.kalshi.volume += orderVolume(entry.kalshiOrder);
    platforms.polymarket.volume += orderVolume(entry.polymarketOrder);
  }
  for (const entry of closedToday) {
    platforms[entry.platform].realizedPnl += finite(entry.realizedPnl);
  }

  const realizedPnl = closedToday.reduce((sum, entry) => sum + finite(entry.realizedPnl), 0);
  const unrealizedPnl = positions.reduce((sum, entry) => sum + finite(entry.breakdown?.totalNetPnl), 0);
  const wins = closedToday.filter((entry) => finite(entry.realizedPnl) > 0).length;
  const totalVolume = platforms.kalshi.volume + platforms.polymarket.volume;

  return {
    date,
    timezone: TIMEZONE,
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    totalTrades: liveExecutions.length,
    winRatePct: closedToday.length ? (wins / closedToday.length) * 100 : 0,
    totalVolume,
    platforms,
  };
}
