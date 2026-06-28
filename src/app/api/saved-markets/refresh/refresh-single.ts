import {
  extractKalshiEventTicker,
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl } from '@/lib/polymarket';
import { fetchClobMarkets, getClobPrices } from '@/lib/polymarket-clob';
import { matchOutcomes, calculateAllArbitrages, parseDepth, computeApy, applyManualMatches } from '@/lib/matcher';
import { getDecoupledPairs, applyDecoupledPairs } from '@/lib/decoupled-pairs';
import { SavedMarket } from '@/lib/persistence';

const API_TIMEOUT_MS = 3000;
const KALSHI_TIMEOUT_MS = 3000;
const PM_TIMEOUT_MS = 3000;
const CLOB_TIMEOUT_MS = 1500;

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

export interface SingleRefreshResult {
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
    fees?: any;
  }[];
}

export async function refreshSingleMarket(market: SavedMarket, manualMatches: any[]): Promise<SingleRefreshResult> {
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
    };
  }

  const [kalshiMarkets, pmEvent] = await Promise.all([
    (async () => {
      try {
        const m = await withTimeout(fetchKalshiEventMarkets(kalshiTicker), KALSHI_TIMEOUT_MS, 'Kalshi event markets');
        if (m.length > 0) return m;
      } catch (e: any) { if (e.message?.includes('timed out')) throw e; }
      const seriesMatch = kalshiTicker.match(/^([A-Z]+)/);
      const seriesFallback = seriesMatch ? seriesMatch[1] : null;
      if (seriesFallback && seriesFallback !== kalshiTicker) {
        try {
          const m = await withTimeout(fetchKalshiSeriesMarkets(seriesFallback), KALSHI_TIMEOUT_MS, 'Kalshi series markets');
          if (m.length > 0) return m;
        } catch (e: any) { if (e.message?.includes('timed out')) throw e; }
      }
      try {
        const m = await withTimeout(fetchKalshiSeriesMarkets(kalshiTicker), KALSHI_TIMEOUT_MS, 'Kalshi series markets');
        if (m.length > 0) return m;
      } catch (e: any) { if (e.message?.includes('timed out')) throw e; }
      return [] as any[];
    })(),
    withTimeout(
      isPolymarketMarketUrl(market.polymarketUrl)
        ? fetchPolymarketMarketAsEvent(pmSlug)
        : fetchPolymarketEvent(pmSlug),
      PM_TIMEOUT_MS, 'Polymarket event',
    ),
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
    };
  }

  const pmMarketsRaw = chooseBestPmStructure(pmEvent.markets || [], kalshiMarkets, pmEvent.title);
  const conditionIds = pmMarketsRaw.map(m => m.conditionId).filter(Boolean) as string[];
  // Limit concurrent CLOB metadata calls per market to avoid CLOB overload / timeout storms
  let clobMap: Map<string, any>;
  try {
    clobMap = await withTimeout(
      fetchClobMarkets(conditionIds.slice(0, 6)),
      CLOB_TIMEOUT_MS,
      'CLOB metadata',
    );
  } catch (e: any) {
    console.warn(`[refresh-single] CLOB metadata unavailable for ${market.eventTitle}: ${e.message}. Falling back to gamma prices.`);
    clobMap = new Map();
  }

  const pmMarkets: any[] = [];
  for (const m of pmMarketsRaw) {
    const clob = clobMap.get(m.conditionId);
    if (!clob) {
      pmMarkets.push(m);
      continue;
    }
    try {
      const live = await withTimeout(getClobPrices(clob), CLOB_TIMEOUT_MS, 'CLOB prices');
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
    } catch (e: any) {
      console.warn(`[refresh-single] CLOB timeout for ${market.eventTitle}: ${e.message}`);
      pmMarkets.push(m);
    }
  }

  const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent.title, 1000, pmEvent.endDate);
  const outcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, 1000, pmEvent.endDate);
  const decoupledPairs = await getDecoupledPairs();
  const splitOutcomes = applyDecoupledPairs(outcomes, decoupledPairs);

  const withArbitrage = calculateAllArbitrages(splitOutcomes, market.category || pmEvent.title).map(o => ({
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
      fees: o.arbitrage!.fees,
    })),
  };
}
