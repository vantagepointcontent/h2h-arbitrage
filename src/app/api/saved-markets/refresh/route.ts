import { NextRequest, NextResponse } from 'next/server';
import {
  extractKalshiEventTicker,
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent } from '@/lib/polymarket';
import { fetchClobMarkets, getClobPrices } from '@/lib/polymarket-clob';
import { matchOutcomes, calculateArbitrageMax, parseDepth, computeApy, applyManualMatches } from '@/lib/matcher';
import { getManualMatches } from '@/lib/manual-matches';
import { getSavedMarkets, SavedMarket, updateSavedMarketScanResult, LastScanResult } from '@/lib/persistence';

const API_TIMEOUT_MS = 15000;
const BATCH_SIZE = 3; // Process markets in batches of 3 to rate-limit API calls
const BATCH_DELAY_MS = 500; // Delay between batches

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

interface MarketRefreshResult {
  id: string;
  eventTitle: string;
  bestRoiPct: number;
  bestProfit: number;
  strategy: string;
  matchedCount: number;
  kalshiCount: number;
  pmCount: number;
  scannedAt: string;
  totalStake: number;
  expiryDate?: string | null;
  allArbs: {
    artist: string;
    roiPct: number;
    expectedProfit: number;
    strategy: string;
    totalStake: number;
  }[];
  error?: string;
}

async function refreshSingleMarket(market: SavedMarket, manualMatches: any[]): Promise<MarketRefreshResult> {
  const kalshiTicker = extractKalshiEventTicker(market.kalshiUrl);
  const pmSlug = extractPolymarketSlug(market.polymarketUrl);

  if (!kalshiTicker || !pmSlug) {
    return {
      id: market.id,
      eventTitle: market.eventTitle,
      bestRoiPct: 0,
      bestProfit: 0,
      strategy: 'No arb',
      matchedCount: 0,
      kalshiCount: 0,
      pmCount: 0,
      scannedAt: new Date().toISOString(),
      totalStake: 0,
      allArbs: [],
      error: `Invalid URLs for ${market.eventTitle}`,
    };
  }

  let kalshiFetchSource: 'event_ticker' | 'series_prefix' | 'series_ticker' | 'none' = 'none';
  const [kalshiMarkets, pmEvent] = await Promise.all([
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
    withTimeout(fetchPolymarketEvent(pmSlug), API_TIMEOUT_MS, 'Polymarket event'),
  ]);

  if (!pmEvent) {
    return {
      id: market.id,
      eventTitle: market.eventTitle,
      bestRoiPct: 0,
      bestProfit: 0,
      strategy: 'No arb',
      matchedCount: 0,
      kalshiCount: kalshiMarkets.length,
      pmCount: 0,
      scannedAt: new Date().toISOString(),
      totalStake: 0,
      allArbs: [],
      error: 'Polymarket event not found',
    };
  }

  const pmMarketsRaw = chooseBestPmStructure(pmEvent.markets || [], kalshiMarkets, pmEvent.title);
  const conditionIds = pmMarketsRaw.map(m => m.conditionId).filter(Boolean) as string[];
  const clobMap = await fetchClobMarkets(conditionIds);

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
      outcomePrices: JSON.stringify([live.yesPrice.toFixed(6), live.noPrice.toFixed(6)]),
      bestBid: live.bestBid != null ? live.bestBid : m.bestBid,
      bestAsk: live.bestAsk != null ? live.bestAsk : m.bestAsk,
      lastTradePrice: live.lastTradePrice,
      noAskDepth: Number(m.liquidityNum ?? m.liquidity ?? 0),
    });
  }

  const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent.title, 1000, pmEvent.endDate);
  const outcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, 1000, pmEvent.endDate);

  const withArbitrage = outcomes.map(o => {
    if (!o.kalshi || !o.polymarket) {
      return { ...o, arbitrage: { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, maxCapital: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 } };
    }
    const depthKYes = parseDepth(o.kalshi.yesAskDepth);
    const depthKNo = parseDepth(o.kalshi.noAskDepth) || parseDepth(o.kalshi.yesAskDepth);
    // PM liquidityNum is NOT order depth — only Kalshi depth limits capital.
    // Use Infinity for PM so profit isn't artificially capped.
    const depthPYes = o.polymarket.askDepth > 0 ? o.polymarket.askDepth : Infinity;
    const depthPNo = o.polymarket.noAskDepth > 0 ? o.polymarket.noAskDepth : Infinity;
    const arbResult = calculateArbitrageMax(o.kalshi, o.polymarket, depthKYes, depthKNo, depthPYes, depthPNo);
    return { ...o, arbitrage: { ...arbResult, apyPct: computeApy(arbResult.roiPct, pmEvent.endDate) } };
  });

  const kalshiCount = withArbitrage.filter(o => o.kalshi).length;
  const pmCount = withArbitrage.filter(o => o.polymarket).length;
  const matchedCount = withArbitrage.filter(o => o.kalshi && o.polymarket).length;

  const positiveArbs = withArbitrage.filter(o => o.arbitrage && o.arbitrage.roiPct > 0);
  const bestArb = positiveArbs.length > 0
    ? positiveArbs.reduce((best, o) => o.arbitrage!.roiPct > best.arbitrage!.roiPct ? o : best)
    : null;

  return {
    id: market.id,
    eventTitle: market.eventTitle,
    bestRoiPct: bestArb ? bestArb.arbitrage!.roiPct : 0,
    bestProfit: bestArb ? bestArb.arbitrage!.expectedProfit : 0,
    strategy: bestArb ? bestArb.arbitrage!.strategy : 'No arb',
    matchedCount,
    kalshiCount,
    pmCount,
    scannedAt: new Date().toISOString(),
    totalStake: bestArb ? (bestArb.arbitrage!.kalshiStake ?? 0) + (bestArb.arbitrage!.pmStake ?? 0) : 0,
    expiryDate: pmEvent.endDate,
    allArbs: positiveArbs.map(o => ({
      artist: o.artist,
      roiPct: o.arbitrage!.roiPct,
      expectedProfit: o.arbitrage!.expectedProfit,
      strategy: o.arbitrage!.strategy,
      totalStake: (o.arbitrage!.kalshiStake ?? 0) + (o.arbitrage!.pmStake ?? 0),
    })),
  };
}

export async function GET(_: NextRequest) {
  try {
    const markets = await getSavedMarkets();
    if (markets.length === 0) {
      return NextResponse.json({ markets: [], refreshed: [], total: 0 });
    }

    const manualMatches = await getManualMatches();
    const results: MarketRefreshResult[] = [];

    // Process in batches to rate-limit API calls
    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
      const batch = markets.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(m => refreshSingleMarket(m, manualMatches));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Delay between batches (except after the last batch)
      if (i + BATCH_SIZE < markets.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    // Persist scan results to disk (updates lastScanResult in-place, preserving favorites)
    for (const [i, result] of results.entries()) {
      const market = markets[i];
      const scanResult: LastScanResult = {
        bestRoiPct: result.bestRoiPct,
        bestProfit: result.bestProfit,
        strategy: result.strategy,
        outcomeCount: result.matchedCount,
        matchedCount: result.matchedCount,
        kalshiCount: result.kalshiCount,
        pmCount: result.pmCount,
        scannedAt: result.scannedAt,
        allArbs: result.allArbs.map(a => ({
          artist: a.artist,
          roiPct: a.roiPct,
          expectedProfit: a.expectedProfit,
          strategy: a.strategy,
        })),
      };
      await updateSavedMarketScanResult(market.id, scanResult, result.expiryDate);
    }

    return NextResponse.json({
      markets,
      refreshed: results,
      total: results.length,
      scannedAt: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: any) {
    console.error('[saved-markets-refresh-error]', err);
    return NextResponse.json(
      { error: err.message || 'Failed to refresh saved markets' },
      { status: 500 }
    );
  }
}
