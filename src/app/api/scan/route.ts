import { NextRequest, NextResponse } from 'next/server';
import {
  extractKalshiEventTicker,
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent } from '@/lib/polymarket';
import { matchOutcomes, calculateArbitrage } from '@/lib/matcher';

// Detect if a Polymarket event contains only named binary outcome markets
// (e.g. Drake artists, where each market = one artist, outcomes=[Yes,No])
// vs. events with numbered outcomes + sub-markets (e.g. tennis with over/under sub-markets)
function filterPolymarketMarkets(markets: any[]): any[] {
  if (!markets || markets.length === 0) return [];

  const hasAnyEmpty = markets.some((m: any) => {
    const g = m.groupItemTitle;
    return !g || g === '' || g === 'N/A';
  });

  // If no empty groupItemTitle exists, ALL markets are likely named binary outcomes → keep all
  if (!hasAnyEmpty) return markets;

  // Mixed: some empty (main markets), some with title (sub-markets) → keep only empty ones
  return markets.filter((m: any) => {
    const group = m.groupItemTitle;
    return !group || group === '' || group === 'N/A';
  });
}

export async function POST(request: NextRequest) {
  try {
    const { kalshiUrl, polymarketUrl } = await request.json();

    const kalshiTicker = extractKalshiEventTicker(kalshiUrl);
    const pmSlug = extractPolymarketSlug(polymarketUrl);

    if (!kalshiTicker || !pmSlug) {
      return NextResponse.json(
        { error: 'Invalid URLs. Kalshi format: /markets/{series}/.../{ticker}, Polymarket format: /event/{slug}' },
        { status: 400 }
      );
    }

    // Kalshi: try event_ticker first, fallback to series_ticker
    const [kalshiMarkets, pmEvent] = await Promise.all([
      (async () => {
        try {
          const m = await fetchKalshiEventMarkets(kalshiTicker);
          if (m.length > 0) return m;
        } catch {}
        try {
          const m = await fetchKalshiSeriesMarkets(kalshiTicker);
          if (m.length > 0) return m;
        } catch {}
        return [] as any[];
      })(),
      fetchPolymarketEvent(pmSlug),
    ]);

    if (!pmEvent) {
      return NextResponse.json(
        { error: 'Polymarket event not found' },
        { status: 404 }
      );
    }

    const pmMarkets = filterPolymarketMarkets(pmEvent.markets || []);
    const outcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent.title);

    const withArbitrage = outcomes.map(o => ({
      ...o,
      arbitrage: o.kalshi && o.polymarket ? calculateArbitrage(o.kalshi, o.polymarket, 1000) : { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 },
    }));

    return NextResponse.json({
      eventTitle: pmEvent.title,
      kalshiEventTicker: kalshiTicker,
      pmEventSlug: pmSlug,
      pmEventId: pmEvent.id,
      kalshiCount: outcomes.filter(o => o.kalshi).length,
      pmCount: outcomes.filter(o => o.polymarket).length,
      matchedCount: outcomes.filter(o => o.kalshi && o.polymarket).length,
      outcomes: withArbitrage,
      _ts: Date.now(),
      _kalshiFetchedAt: new Date().toISOString(),
      _pmFetchedAt: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      }
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unknown error' },
      { status: 500 }
    );
  }
}
