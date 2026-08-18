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
    status, priceCents: null, priceMicrocents: null, source: null, observedAt: null, ageMs: null,
    executableDepthMicros: null, failureReason: null, markFailureReason: null,
  };
}

function polymarketToken(position: BotPosition): string | null {
  return position.pmEntryTokenId ?? position.pmExitTokenId
    ?? (position.pmConditionId && /^\d+$/.test(position.pmConditionId) ? position.pmConditionId : null);
}

function exactLegBlocker(platform: 'Kalshi' | 'Polymarket', snapshot: PersistedPriceSnapshot): string {
  if (snapshot.status === 'missing_identifier') return `${platform} exact market identifier is missing`;
  if (snapshot.status === 'side_mismatch') return `${platform} exact held side/token snapshot is missing`;
  if (snapshot.status === 'never_saved') return `${platform} exact held-side scan snapshot has never been recorded`;
  return `${platform} last-scanned price is unavailable`;
}

function roundedRatio(numerator: bigint, denominator: bigint): number {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  const value = Number(negative ? -rounded : rounded);
  if (!Number.isSafeInteger(value)) throw new Error('Indicative mark exceeds safe integer range');
  return value;
}

function snapshotMicrocents(snapshot: PersistedPriceSnapshot): number | null {
  if (Number.isSafeInteger(snapshot.priceMicrocents)
    && snapshot.priceMicrocents! >= 0 && snapshot.priceMicrocents! <= 100_000_000) {
    return snapshot.priceMicrocents!;
  }
  return Number.isSafeInteger(snapshot.priceCents)
    && snapshot.priceCents! >= 0 && snapshot.priceCents! <= 100
    ? snapshot.priceCents! * 1_000_000
    : null;
}

function applyPersistedIndicativeValuation(
  position: BotPosition,
  kalshi: PersistedPriceSnapshot,
  polymarket: PersistedPriceSnapshot,
): BotPosition {
  if (position.status !== 'open') return position;
  const available = (snapshot: PersistedPriceSnapshot) =>
    (snapshot.status === 'available' || snapshot.status === 'stale')
    && snapshotMicrocents(snapshot) != null
    && snapshot.observedAt != null && Number.isFinite(Date.parse(snapshot.observedAt));
  if (!available(kalshi) || !available(polymarket)) {
    const blockers = [
      ...(!available(kalshi) ? [exactLegBlocker('Kalshi', kalshi)] : []),
      ...(!available(polymarket) ? [exactLegBlocker('Polymarket', polymarket)] : []),
    ];
    return {
      ...position,
      currentPriceKalshiCents: available(kalshi) ? kalshi.priceCents : null,
      currentPricePmCents: available(polymarket) ? polymarket.priceCents : null,
      currentValueCents: null,
      unrealizedPnlCents: null,
      unrealizedRoiBps: null,
      valuationStatus: 'unavailable',
      valuationFailureReason: blockers.join('; '),
    };
  }

  const kalshiQuantity = position.remainingSharesKalshi;
  const pmQuantity = position.remainingSharesPm;
  if (!Number.isSafeInteger(kalshiQuantity) || kalshiQuantity < 0
    || !Number.isSafeInteger(pmQuantity) || pmQuantity < 0) {
    return {
      ...position,
      currentValueCents: null,
      unrealizedPnlCents: null,
      unrealizedRoiBps: null,
      valuationStatus: 'unavailable',
      valuationFailureReason: 'Persisted held quantity is unavailable',
    };
  }
  const indicativeValueMicrocents = Number(
    BigInt(snapshotMicrocents(kalshi)!) * BigInt(kalshiQuantity)
      + BigInt(snapshotMicrocents(polymarket)!) * BigInt(pmQuantity),
  );
  if (!Number.isSafeInteger(indicativeValueMicrocents)) throw new Error('Indicative current value exceeds safe integer range');
  const currentValueCents = roundedRatio(BigInt(indicativeValueMicrocents), 1_000_000n);
  const lastValuationAt = [kalshi.observedAt!, polymarket.observedAt!].sort()[0];
  const stale = kalshi.status === 'stale' || polymarket.status === 'stale';
  const valuationFailureReason = stale
    ? [kalshi, polymarket].filter((snapshot) => snapshot.status === 'stale').map((snapshot) => {
      const platform = snapshot === kalshi ? 'Kalshi' : 'Polymarket';
      const age = snapshot.ageMs == null ? 'unknown age' : `${Math.floor(snapshot.ageMs / 60_000)}m old`;
      const failure = snapshot.markFailureReason ? `; ${snapshot.markFailureReason}` : '';
      return `${platform} Stale last-scanned mark (${age}, ${snapshot.source ?? 'unknown source'}${failure})`;
    }).join('; ')
    : null;
  // BUG-160 defines Buy Cost as immutable persisted entry cost. Do not switch
  // this mark-to-market formula to remaining basis or executable close cost.
  const buyCostMicrocents = Number.isSafeInteger(position.totalCostMicrousd) && position.totalCostMicrousd! >= 0
    ? position.totalCostMicrousd! * 100
    : Number.isSafeInteger(position.totalCostCents) && position.totalCostCents >= 0
      ? position.totalCostCents * 1_000_000
      : null;
  const entryAvailable = position.entryCostStatus === 'available'
    && buyCostMicrocents != null && Number.isSafeInteger(buyCostMicrocents);
  const indicativePnlMicrocents = entryAvailable ? indicativeValueMicrocents - buyCostMicrocents : null;
  const unrealizedPnlCents = indicativePnlMicrocents == null
    ? null
    : roundedRatio(BigInt(indicativePnlMicrocents), 1_000_000n);
  const unrealizedRoiBps = indicativePnlMicrocents != null && buyCostMicrocents! > 0
    ? roundedRatio(BigInt(indicativePnlMicrocents) * 10_000n, BigInt(buyCostMicrocents!))
    : null;
  return {
    ...position,
    currentPriceKalshiCents: kalshi.priceCents,
    currentPricePmCents: polymarket.priceCents,
    currentValueCents,
    indicativeValueMicrocents,
    ...(buyCostMicrocents == null ? {} : { indicativeBuyCostMicrocents: buyCostMicrocents }),
    ...(indicativePnlMicrocents == null ? {} : { indicativePnlMicrocents }),
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
        ...applyPersistedIndicativeValuation(position, kalshiSnapshot, polymarketSnapshot),
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
