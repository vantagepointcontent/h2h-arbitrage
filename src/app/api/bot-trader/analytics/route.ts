import { NextRequest, NextResponse } from 'next/server';
import { getBotPositionAnalytics } from '@/lib/bot-positions';
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
  return { status, priceCents: null, source: null, observedAt: null, ageMs: null };
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
      { platform: 'polymarket', marketId: position.pmConditionId, side: position.pmSide, tokenId: position.pmEntryTokenId ?? position.pmExitTokenId ?? null },
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
    const enriched = {
      ...analytics,
      positions: positions.map((position) => ({
        ...position,
        kalshiUrl: position.marketId ? urlByMarket.get(position.marketId)?.kalshiUrl ?? null : null,
        polymarketUrl: position.marketId ? urlByMarket.get(position.marketId)?.polymarketUrl ?? null : null,
        currentPriceSnapshots: {
          kalshi: snapshotFor({ platform: 'kalshi', marketId: position.kalshiTicker, side: position.kalshiSide, tokenId: null }),
          polymarket: snapshotFor({ platform: 'polymarket', marketId: position.pmConditionId, side: position.pmSide, tokenId: position.pmEntryTokenId ?? position.pmExitTokenId ?? null }),
        },
      })),
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
