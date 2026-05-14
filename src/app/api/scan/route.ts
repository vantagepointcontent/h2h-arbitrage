import { NextRequest, NextResponse } from 'next/server';
import { extractKalshiEventTicker, fetchKalshiEventMarkets } from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent } from '@/lib/polymarket';
import { matchOutcomes, calculateArbitrage, UnifiedOutcome } from '@/lib/matcher';

export async function POST(request: NextRequest) {
  try {
    const { kalshiUrl, polymarketUrl } = await request.json();

    const kalshiEventTicker = extractKalshiEventTicker(kalshiUrl);
    const pmSlug = extractPolymarketSlug(polymarketUrl);

    if (!kalshiEventTicker || !pmSlug) {
      return NextResponse.json(
        { error: 'Invalid URLs. Kalshi format: /markets/{series}/.../{ticker}, Polymarket format: /event/{slug}' },
        { status: 400 }
      );
    }

    const [kalshiMarkets, pmEvent] = await Promise.all([
      fetchKalshiEventMarkets(kalshiEventTicker),
      fetchPolymarketEvent(pmSlug),
    ]);

    if (!pmEvent) {
      return NextResponse.json(
        { error: 'Polymarket event not found' },
        { status: 404 }
      );
    }

    const pmMarkets = pmEvent.markets || [];
    const outcomes = matchOutcomes(kalshiMarkets, pmMarkets);

    const withArbitrage = outcomes.map(o => ({
      ...o,
      arbitrage: calculateArbitrage(o, 1000),
    }));

    return NextResponse.json({
      eventTitle: pmEvent.title,
      kalshiEventTicker,
      pmEventSlug: pmSlug,
      pmEventId: pmEvent.id,
      kalshiCount: kalshiMarkets.length,
      pmCount: pmMarkets.length,
      matchedCount: outcomes.filter(o => o.kalshi && o.polymarket).length,
      outcomes: withArbitrage,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unknown error' },
      { status: 500 }
    );
  }
}
