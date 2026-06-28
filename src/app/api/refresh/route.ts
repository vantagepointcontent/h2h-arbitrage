import { NextRequest, NextResponse } from 'next/server';
import {
  extractKalshiEventTicker,
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl } from '@/lib/polymarket';
import { fetchClobMarkets, getClobPrices } from '@/lib/polymarket-clob';
import { matchOutcomes, calculateAllArbitrages, parseDepth, computeApy, applyManualMatches } from '@/lib/matcher';
import { getManualMatches } from '@/lib/manual-matches';
import { getDecoupledPairs, applyDecoupledPairs } from '@/lib/decoupled-pairs';

const API_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

function chooseBestPmStructure(
  allPmMarkets: any[],
  kalshiMarkets: any[],
  pmEventTitle: string,
): any[] {
  const namedMarkets = allPmMarkets.filter((m: any) =>
    m.groupItemTitle && m.groupItemTitle !== '' && m.groupItemTitle !== 'N/A'
  );
  const unnamedMarkets = allPmMarkets.filter((m: any) =>
    !m.groupItemTitle || m.groupItemTitle === '' || m.groupItemTitle === 'N/A'
  );

  if (namedMarkets.length === 0) return unnamedMarkets;
  if (unnamedMarkets.length === 0) return namedMarkets;

  const namedOutcomes = matchOutcomes(kalshiMarkets, namedMarkets, pmEventTitle, 1000);
  const unnamedOutcomes = matchOutcomes(kalshiMarkets, unnamedMarkets, pmEventTitle, 1000);

  const namedMatched = namedOutcomes.filter((o: any) => o.kalshi && o.polymarket).length;
  const unnamedMatched = unnamedOutcomes.filter((o: any) => o.kalshi && o.polymarket).length;

  if (namedMatched === 0 && unnamedMatched === 0) return allPmMarkets;
  if (namedMatched >= unnamedMatched) return namedMarkets;
  return unnamedMarkets;
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
        { error: 'Invalid Kalshi URL' }, { status: 400 }
      );
    }
    if (!pmSlug) {
      return NextResponse.json(
        { error: 'Invalid Polymarket URL' }, { status: 400 }
      );
    }

    let kalshiFetchSource: 'event_ticker' | 'series_prefix' | 'series_ticker' | 'none' = 'none';
    const [kalshiMarkets, pmEvent, manualMatches, decoupledPairs] = await Promise.all([
      (async () => {
        try {
          const m = await withTimeout(fetchKalshiEventMarkets(kalshiTicker), API_TIMEOUT_MS, 'Kalshi event markets');
          if (m.length > 0) { kalshiFetchSource = 'event_ticker'; return m; }
        } catch (e: any) { if (e.message?.includes('timed out')) throw e; }
        const seriesMatch = kalshiTicker.match(/^([A-Z]+)/);
        const seriesFallback = seriesMatch ? seriesMatch[1] : null;
        if (seriesFallback && seriesFallback !== kalshiTicker) {
          try {
            const m = await withTimeout(fetchKalshiSeriesMarkets(seriesFallback), API_TIMEOUT_MS, 'Kalshi series markets');
            if (m.length > 0) { kalshiFetchSource = 'series_prefix'; return m; }
          } catch (e: any) { if (e.message?.includes('timed out')) throw e; }
        }
        try {
          const m = await withTimeout(fetchKalshiSeriesMarkets(kalshiTicker), API_TIMEOUT_MS, 'Kalshi series markets');
          if (m.length > 0) { kalshiFetchSource = 'series_ticker'; return m; }
        } catch (e: any) { if (e.message?.includes('timed out')) throw e; }
        return [] as any[];
      })(),
      withTimeout(
        isPolymarketMarketUrl(polymarketUrl)
          ? fetchPolymarketMarketAsEvent(pmSlug)
          : fetchPolymarketEvent(pmSlug),
        API_TIMEOUT_MS, 'Polymarket event',
      ),
      getManualMatches(),
      getDecoupledPairs(),
    ]);

    if (!pmEvent) {
      return NextResponse.json(
        { error: 'Polymarket event not found' }, { status: 404 }
      );
    }

    // ---- LIVE CLOB ENRICHMENT ----
    const pmRawCount = (pmEvent.markets || []).length;
    const pmMarketsRaw = chooseBestPmStructure(pmEvent.markets || [], kalshiMarkets, pmEvent.title);
    const conditionIds = pmMarketsRaw.map(m => m.conditionId).filter(Boolean) as string[];
    const clobMap = await fetchClobMarkets(conditionIds);

    // Enrich markets with CLOB prices (async for neg-risk token orderbooks)
    const pmMarkets: any[] = [];
    for (const m of pmMarketsRaw) {
      const clob = clobMap.get(m.conditionId);
      if (!clob) {
        pmMarkets.push(m);
        continue;
      }
      const live = await getClobPrices(clob);
      if (!live) {
        pmMarkets.push(m);
        continue;
      }
      pmMarkets.push({
        ...m,
        // If CLOB has orderbook data, use it. Otherwise keep gamma's bestBid/bestAsk.
        outcomePrices: JSON.stringify([live.yesPrice.toFixed(6), live.noPrice.toFixed(6)]),
        bestBid: live.bestBid != null ? live.bestBid : m.bestBid,
        bestAsk: live.bestAsk != null ? live.bestAsk : m.bestAsk,
        lastTradePrice: live.lastTradePrice,
        noAskDepth: Number(m.liquidityNum ?? m.liquidity ?? 0),
      });
    }

    // Matching & arbitrage
    const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent.title, 1000, pmEvent.endDate);
    const outcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, 1000, pmEvent.endDate);
    const splitOutcomes = applyDecoupledPairs(outcomes, decoupledPairs);

    const withArbitrage = calculateAllArbitrages(splitOutcomes, pmEvent.title).map(o => ({
      ...o,
      arbitrage: { ...o.arbitrage, apyPct: computeApy(o.arbitrage.roiPct, pmEvent.endDate) },
    }));

    const kalshiCount = withArbitrage.filter(o => o.kalshi).length;
    const pmCount = withArbitrage.filter(o => o.polymarket).length;
    const matchedCount = withArbitrage.filter(o => o.kalshi && o.polymarket).length;

    const positiveArbs = withArbitrage.filter(o => o.arbitrage && o.arbitrage.roiPct > 0);
    const bestArb = positiveArbs.length > 0
      ? positiveArbs.reduce((best, o) => o.arbitrage!.roiPct > best.arbitrage!.roiPct ? o : best)
      : null;

    return NextResponse.json({
      eventTitle: pmEvent.title,
      pmEventSlug: pmSlug,
      expiryDate: pmEvent.endDate,
      kalshiCount, pmCount, matchedCount,
      clobHitCount: clobMap.size,
      bestRoiPct: bestArb ? bestArb.arbitrage!.roiPct : 0,
      bestProfit: bestArb ? bestArb.arbitrage!.expectedProfit : 0,
      strategy: bestArb ? bestArb.arbitrage!.strategy : 'No arb',
      allArbs: positiveArbs.map(o => ({
        artist: o.artist,
        roiPct: o.arbitrage!.roiPct,
        expectedProfit: o.arbitrage!.expectedProfit,
        strategy: o.arbitrage!.strategy,
        totalStake: (o.arbitrage!.kalshiStake ?? 0) + (o.arbitrage!.pmStake ?? 0),
        fees: o.arbitrage!.fees,
      })),
      scannedAt: new Date().toISOString(),
      _ts: Date.now(),
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      }
    });
  } catch (err: any) {
    console.error('[refresh-api-error]', err);
    const msg = err.message || 'Unknown error';
    const status = msg.includes('timed out') ? 504 : msg.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
