import { NextRequest, NextResponse } from 'next/server';
import { getBotPositionAnalytics, summarizeBotPerformance, type BotPosition } from '@/lib/bot-positions';
import { clientSafeError } from '@/lib/error-handler';
import { DASHBOARD_RANGES, type DashboardRange } from '@/lib/dashboard-request';
import { getMarketUrlsById } from '@/lib/persistence';
import {
  currentPriceSnapshotKey,
  getPersistedCurrentPriceBatch,
  type PersistedPriceSnapshot,
  type PriceSnapshotRequest,
} from '@/lib/current-price-snapshots';

function missingSnapshot(status: 'missing_identifier' | 'never_saved'): PersistedPriceSnapshot {
  return {
    status, priceCents: null, source: null, observedAt: null, ageMs: null,
    executableDepthMicros: null, failureReason: null,
  };
}

function polymarketToken(position: BotPosition): string | null {
  return position.pmEntryTokenId ?? position.pmExitTokenId
    ?? (position.pmConditionId && /^\d+$/.test(position.pmConditionId) ? position.pmConditionId : null);
}

function exactLegBlocker(platform: 'Kalshi' | 'Polymarket', snapshot: PersistedPriceSnapshot): string {
  if (snapshot.failureReason) return snapshot.failureReason;
  if (snapshot.status === 'missing_identifier') return `${platform} exact market identifier is missing`;
  if (snapshot.status === 'side_mismatch') return `${platform} exact held side/token snapshot is missing`;
  if (snapshot.status === 'never_saved') return `${platform} exact executable market has never been recorded`;
  if (snapshot.status === 'stale') return `${platform} persisted executable quote is stale`;
  return `${platform} one-share executable bid is unavailable`;
}

function applyPersistedExecutableValuation(
  position: BotPosition,
  kalshi: PersistedPriceSnapshot,
  polymarket: PersistedPriceSnapshot,
): BotPosition {
  if (position.status !== 'open') return position;
  const currentPriceKalshiCents = Number.isSafeInteger(kalshi.priceCents) ? kalshi.priceCents : position.currentPriceKalshiCents;
  const currentPricePmCents = Number.isSafeInteger(polymarket.priceCents) ? polymarket.priceCents : position.currentPricePmCents;

  const executable = (snapshot: PersistedPriceSnapshot) =>
    (snapshot.status === 'available' || snapshot.status === 'stale')
    && Number.isSafeInteger(snapshot.priceCents)
    && Number.isSafeInteger(snapshot.executableDepthMicros)
    && snapshot.executableDepthMicros! >= 1_000_000
    && snapshot.observedAt != null && Number.isFinite(Date.parse(snapshot.observedAt));
  if (!executable(kalshi) || !executable(polymarket)) {
    if (position.currentValueCents != null) {
      return { ...position, currentPriceKalshiCents, currentPricePmCents };
    }
    const blockers = [
      ...(!executable(kalshi) ? [exactLegBlocker('Kalshi', kalshi)] : []),
      ...(!executable(polymarket) ? [exactLegBlocker('Polymarket', polymarket)] : []),
    ];
    return {
      ...position,
      currentPriceKalshiCents,
      currentPricePmCents,
      valuationStatus: 'unavailable',
      valuationFailureReason: blockers.join('; '),
    };
  }

  const currentValueCents = kalshi.priceCents! + polymarket.priceCents!;
  const lastValuationAt = [kalshi.observedAt!, polymarket.observedAt!].sort()[0];
  const stale = kalshi.status === 'stale' || polymarket.status === 'stale';
  const valuationFailureReason = stale
    ? [
      ...(kalshi.status === 'stale' ? [exactLegBlocker('Kalshi', kalshi)] : []),
      ...(polymarket.status === 'stale' ? [exactLegBlocker('Polymarket', polymarket)] : []),
    ].join('; ')
    : null;
  const entryAvailable = position.remainingSharesKalshi === 1 && position.remainingSharesPm === 1
    && position.entryCostStatus === 'available'
    && Number.isSafeInteger(position.remainingOpenCostCents);
  const unrealizedPnlCents = entryAvailable
    ? (position.realizedPnlCents ?? 0) + currentValueCents - position.remainingOpenCostCents
    : null;
  const unrealizedRoiBps = unrealizedPnlCents != null && position.remainingOpenCostCents > 0
    ? Math.round((unrealizedPnlCents * 10_000) / position.remainingOpenCostCents)
    : null;
  return {
    ...position,
    currentPriceKalshiCents: kalshi.priceCents,
    currentPricePmCents: polymarket.priceCents,
    currentValueCents,
    kalshiLiquidationValueCents: kalshi.priceCents,
    pmLiquidationValueCents: polymarket.priceCents,
    kalshiValuationDepth: 1,
    pmValuationDepth: 1,
    kalshiQuoteTimestamp: kalshi.observedAt,
    pmQuoteTimestamp: polymarket.observedAt,
    kalshiQuoteSource: kalshi.source,
    pmQuoteSource: polymarket.source,
    lastValuationAt,
    valuationStatus: stale ? 'stale' : 'current',
    valuationFailureReason,
    valuationFailureAt: stale ? [kalshi, polymarket]
      .filter((snapshot) => snapshot.status === 'stale')
      .map((snapshot) => snapshot.observedAt!)
      .sort().at(-1) ?? lastValuationAt : null,
    unrealizedPnlCents,
    unrealizedRoiBps,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const method = request.nextUrl.searchParams.get('method') ?? 'all';
    const mode = request.nextUrl.searchParams.get('mode') ?? 'all';
    const range = request.nextUrl.searchParams.get('range') ?? '30d';
    if (!['all', 'roi', 'apy', 'hybrid', 'legacy'].includes(method)
      || !['all', 'paper', 'production'].includes(mode)
      || !DASHBOARD_RANGES.includes(range as DashboardRange)) {
      return NextResponse.json({ success: false, error: 'Invalid analytics filter' }, { status: 400 });
    }
    const analytics = await getBotPositionAnalytics({
      method: method as 'all' | 'roi' | 'apy' | 'hybrid' | 'legacy',
      mode: mode as 'all' | 'paper' | 'production',
      range: range as DashboardRange,
    });
    const urlByMarket = new Map<string, Awaited<ReturnType<typeof getMarketUrlsById>>>();
    const positions = analytics.positions ?? [];
    const marketIds = [...new Set(positions.map((position) => position.marketId).filter((id): id is string => Boolean(id)))];
    const legRequests = positions.flatMap((position): PriceSnapshotRequest[] => [
      { platform: 'kalshi', marketId: position.kalshiTicker, side: position.kalshiSide, tokenId: null },
      { platform: 'polymarket', marketId: position.pmConditionId, side: position.pmSide, tokenId: polymarketToken(position) },
    ]);
    const deduplicatedLegs = [...new Map(legRequests.map((leg) => [currentPriceSnapshotKey(leg), leg])).values()];
    const [, priceSnapshots] = await Promise.all([
      Promise.all(marketIds.map(async (marketId) => {
        urlByMarket.set(marketId, await getMarketUrlsById(marketId));
      })),
      getPersistedCurrentPriceBatch(deduplicatedLegs),
    ]);
    const snapshotFor = (leg: PriceSnapshotRequest) => priceSnapshots.get(currentPriceSnapshotKey(leg))
      ?? missingSnapshot(leg.marketId ? 'never_saved' : 'missing_identifier');
    const enrichedPositions = positions.map((position) => {
      const kalshiSnapshot = snapshotFor({ platform: 'kalshi', marketId: position.kalshiTicker, side: position.kalshiSide, tokenId: null });
      const polymarketSnapshot = snapshotFor({ platform: 'polymarket', marketId: position.pmConditionId, side: position.pmSide, tokenId: polymarketToken(position) });
      return {
        ...applyPersistedExecutableValuation(position, kalshiSnapshot, polymarketSnapshot),
        kalshiUrl: position.marketId ? urlByMarket.get(position.marketId)?.kalshiUrl ?? null : null,
        polymarketUrl: position.marketId ? urlByMarket.get(position.marketId)?.polymarketUrl ?? null : null,
        currentPriceSnapshots: { kalshi: kalshiSnapshot, polymarket: polymarketSnapshot },
      };
    });
    const reconciledPerformance = analytics.performance
      ? summarizeBotPerformance(enrichedPositions, new Date())
      : undefined;
    const enriched = {
      ...analytics,
      ...(reconciledPerformance ? {
        performance: reconciledPerformance,
        openPositions: { ...analytics.openPositions, unrealizedPnlCents: reconciledPerformance.pnl.unrealizedCents },
        averageRoi: { ...analytics.averageRoi, currentBps: reconciledPerformance.pnl.roiBps },
      } : {}),
      positions: enrichedPositions,
    };
    return NextResponse.json(
      { success: true, analytics: enriched },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: clientSafeError(error, 'BotTrader analytics are temporarily unavailable. Retry in a moment', {
        path: '/api/bot-trader/analytics',
      }),
    }, { status: 503, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
  }
}
