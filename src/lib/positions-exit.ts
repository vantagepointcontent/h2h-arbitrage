import type { ClosedPosition } from './persistence';

export interface ExitLegInput {
  side: 'YES' | 'NO';
  size: number;
  entryPrice: number;
  exitPrice: number;
  feesPaid?: number;
  exitFees?: number;
  title: string;
  openedAt?: string | null;
}

export interface KalshiExitLeg extends ExitLegInput {
  ticker: string;
  priceCents: number;
}

export interface PolymarketExitLeg extends ExitLegInput {
  asset: string;
  conditionId?: string;
  outcome: string;
  price: number;
}

export interface PositionExitRequest {
  pairId: string;
  kalshi?: KalshiExitLeg;
  polymarket?: PolymarketExitLeg;
}

interface ExitDependencies {
  sellKalshi: (leg: KalshiExitLeg, clientOrderId: string) => Promise<{ orderId: string; status: string; filledCount: number }>;
  sellPolymarket: (leg: PolymarketExitLeg) => Promise<{ orderId: string; status: string; success: boolean }>;
  persistClosedPosition: (position: ClosedPosition) => Promise<void>;
  alert: (message: string, metadata: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface PositionExitResult {
  success: boolean;
  partialFill: boolean;
  status: 'closed' | 'partially_closed' | 'open';
  realizedPnl: number;
  results: Record<string, unknown>;
  errors?: Record<string, string>;
  alerts: string[];
}

const RETRIES = 2;
const backoff = (attempt: number) => new Promise((resolve) => setTimeout(resolve, attempt * 200));

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await backoff(attempt + 1);
    }
  }
  throw lastError;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100000) / 100000;
}

function netPnl(leg: ExitLegInput): number {
  return roundMoney((leg.exitPrice - leg.entryPrice) * leg.size - (leg.feesPaid ?? 0) - (leg.exitFees ?? 0));
}

export async function executePositionExit(
  request: PositionExitRequest,
  dependencies: ExitDependencies,
): Promise<PositionExitResult> {
  if (!request.kalshi && !request.polymarket) throw new Error('No positions specified for exit');

  const now = (dependencies.now ?? (() => new Date()))();
  const jobs: Array<Promise<{ platform: 'kalshi' | 'polymarket'; result: Record<string, unknown>; leg: ExitLegInput }>> = [];

  if (request.kalshi) {
    const leg = request.kalshi;
    jobs.push(retry(async () => {
      const result = await dependencies.sellKalshi(leg, `exit-${request.pairId}-${now.getTime()}-kalshi`);
      if (result.status !== 'executed' || result.filledCount < Math.floor(leg.size)) {
        throw new Error(`Kalshi exit not fully filled (${result.filledCount}/${Math.floor(leg.size)}, ${result.status})`);
      }
      return { platform: 'kalshi' as const, result, leg };
    }));
  }

  if (request.polymarket) {
    const leg = request.polymarket;
    jobs.push(retry(async () => {
      const result = await dependencies.sellPolymarket(leg);
      if (!result.success || result.status !== 'matched') {
        throw new Error(`Polymarket exit not fully filled (${result.status})`);
      }
      return { platform: 'polymarket' as const, result, leg };
    }));
  }

  // Both legs start before either is awaited.
  const settled = await Promise.allSettled(jobs);
  const results: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const alerts: string[] = [];
  let realizedPnl = 0;

  for (let index = 0; index < settled.length; index += 1) {
    const platform = request.kalshi && index === 0 ? 'kalshi' : 'polymarket';
    const outcome = settled[index];
    if (outcome.status === 'rejected') {
      errors[platform] = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      continue;
    }

    const { leg, result } = outcome.value;
    const pnl = netPnl(leg);
    realizedPnl += pnl;
    results[outcome.value.platform] = result;
    await dependencies.persistClosedPosition({
      marketTitle: leg.title,
      platform: outcome.value.platform,
      side: leg.side,
      size: leg.size,
      entryPrice: leg.entryPrice,
      exitPrice: leg.exitPrice,
      realizedPnl: pnl,
      roiPct: leg.entryPrice * leg.size > 0 ? pnl / (leg.entryPrice * leg.size) * 100 : 0,
      openedAt: leg.openedAt,
      closedAt: now.toISOString(),
      pairId: request.pairId,
      feesPaid: (leg.feesPaid ?? 0) + (leg.exitFees ?? 0),
      ticker: outcome.value.platform === 'kalshi' ? (request.kalshi?.ticker ?? null) : null,
      conditionId: outcome.value.platform === 'polymarket' ? (request.polymarket?.conditionId ?? null) : null,
      rawData: result,
    });
  }

  const closedCount = settled.filter((item) => item.status === 'fulfilled').length;
  const partialFill = closedCount > 0 && closedCount < settled.length;
  if (partialFill) {
    const message = 'CRITICAL: position exit partially filled after retries; one-leg exposure remains';
    alerts.push(message);
    dependencies.alert(message, { pairId: request.pairId, errors });
  }

  return {
    success: closedCount === settled.length,
    partialFill,
    status: closedCount === settled.length ? 'closed' : partialFill ? 'partially_closed' : 'open',
    realizedPnl,
    results,
    errors: Object.keys(errors).length ? errors : undefined,
    alerts,
  };
}
