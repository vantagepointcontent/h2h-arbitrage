import { NextRequest, NextResponse } from 'next/server';
import {
  extractKalshiEventTicker,
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent } from '@/lib/polymarket';
import { matchOutcomes, calculateArbitrageMax, parseDepth, computeApy, applyManualMatches } from '@/lib/matcher';
import { getManualMatches } from '@/lib/manual-matches';

const API_TIMEOUT_MS = 15000; // 15s timeout for upstream APIs

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

function filterPolymarketMarkets(markets: any[]): any[] {
  if (!markets || markets.length === 0) return [];
  const hasAnyEmpty = markets.some((m: any) => {
    const g = m.groupItemTitle;
    return !g || g === '' || g === 'N/A';
  });
  if (!hasAnyEmpty) return markets;
  return markets.filter((m: any) => {
    const group = m.groupItemTitle;
    return !group || group === '' || group === 'N/A';
  });
}

export async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { kalshiUrl, polymarketUrl } = body;

    const kalshiTicker = kalshiUrl ? extractKalshiEventTicker(kalshiUrl) : null;
    const pmSlug = polymarketUrl ? extractPolymarketSlug(polymarketUrl) : null;

    if (!kalshiTicker) {
      return NextResponse.json(
        { error: 'Invalid Kalshi URL. Expected format: https://kalshi.com/markets/{series}/.../{ticker}' },
        { status: 400 }
      );
    }
    if (!pmSlug) {
      return NextResponse.json(
        { error: 'Invalid Polymarket URL. Expected format: https://polymarket.com/event/{slug} or /sports/{path}' },
        { status: 400 }
      );
    }

    // Kalshi: try event_ticker first, fallback to series_ticker
    const [kalshiMarkets, pmEvent, manualMatches] = await Promise.all([
      (async () => {
        try {
          const m = await withTimeout(fetchKalshiEventMarkets(kalshiTicker), API_TIMEOUT_MS, 'Kalshi event markets');
          if (m.length > 0) return m;
        } catch (e: any) {
          if (e.message?.includes('timed out')) throw e;
        }
        const seriesMatch = kalshiTicker.match(/^([A-Z]+)/);
        const seriesFallback = seriesMatch ? seriesMatch[1] : null;
        if (seriesFallback && seriesFallback !== kalshiTicker) {
          try {
            const m = await withTimeout(fetchKalshiSeriesMarkets(seriesFallback), API_TIMEOUT_MS, 'Kalshi series markets');
            if (m.length > 0) return m;
          } catch (e: any) {
            if (e.message?.includes('timed out')) throw e;
          }
        }
        try {
          const m = await withTimeout(fetchKalshiSeriesMarkets(kalshiTicker), API_TIMEOUT_MS, 'Kalshi series markets');
          if (m.length > 0) return m;
        } catch (e: any) {
          if (e.message?.includes('timed out')) throw e;
        }
        return [] as any[];
      })(),
      withTimeout(fetchPolymarketEvent(pmSlug), API_TIMEOUT_MS, 'Polymarket event'),
      getManualMatches(),
    ]);

    if (!pmEvent) {
      return NextResponse.json(
        { error: 'Polymarket event not found. The market may have closed or the URL may be incorrect.' },
        { status: 404 }
      );
    }

    const pmMarkets = filterPolymarketMarkets(pmEvent.markets || []);

    // Step 1: auto-match
    const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent.title, 1000, pmEvent.endDate);

    // Step 2: apply manual matches to merge auto-unmatched pairs
    const outcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, 1000, pmEvent.endDate);

    // Step 3: compute arbitrage (with depth awareness) for all matched items
    const withArbitrage = outcomes.map(o => {
      if (!o.kalshi || !o.polymarket) {
        return {
          ...o,
          arbitrage: { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, maxCapital: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 },
        };
      }

      const depthKYes = parseDepth(o.kalshi.yesAskDepth);
      const depthKNo = parseDepth(o.kalshi.noAskDepth) || parseDepth(o.kalshi.yesAskDepth);
      const depthPYes = o.polymarket.askDepth || 0;
      const depthPNo = 0;

      const arbResult = calculateArbitrageMax(
        o.kalshi,
        o.polymarket,
        depthKYes,
        depthKNo,
        depthPYes,
        depthPYes,
      );

      return {
        ...o,
        arbitrage: {
          ...arbResult,
          apyPct: computeApy(arbResult.roiPct, pmEvent.endDate),
        },
      };
    });

    const kalshiCount = withArbitrage.filter(o => o.kalshi).length;
    const pmCount = withArbitrage.filter(o => o.polymarket).length;
    const matchedCount = withArbitrage.filter(o => o.kalshi && o.polymarket).length;

    // Unmatched for the manual-matching UI
    const unmatchedKalshi = withArbitrage
      .filter(o => o.kalshi && !o.polymarket)
      .map(o => ({
        ticker: o.kalshi!.ticker,
        title: o.kalshi!.ticker,
        artist: o.artist,
        yesAsk: o.kalshi!.yesAsk,
        noAsk: o.kalshi!.noAsk,
      }));

    const unmatchedPolymarket = withArbitrage
      .filter(o => o.polymarket && !o.kalshi)
      .map(o => ({
        conditionId: o.polymarket!.conditionId,
        marketId: o.polymarket!.marketId,
        title: o.artist,
        yesPrice: o.polymarket!.yesPrice,
        noPrice: o.polymarket!.noPrice,
      }));

    return NextResponse.json({
      eventTitle: pmEvent.title,
      kalshiEventTicker: kalshiTicker,
      pmEventSlug: pmSlug,
      pmEventId: pmEvent.id,
      expiryDate: pmEvent.endDate,
      kalshiCount,
      pmCount,
      matchedCount,
      outcomes: withArbitrage,
      unmatchedKalshi,
      unmatchedPolymarket,
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
    console.error('[scan-api-error]', err);
    const msg = err.message || 'Unknown error';
    const status = msg.includes('timed out') ? 504 : msg.includes('not found') ? 404 : 500;
    return NextResponse.json(
      { error: msg },
      { status }
    );
  }
}
