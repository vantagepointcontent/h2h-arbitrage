import {
  extractKalshiEventTicker,
  extractKalshiMatchKey,
  filterKalshiMarketsToMatch,
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
  fetchKalshiMultiSeriesMarkets,
  extractKalshiSeriesFromUrl,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl } from '@/lib/polymarket';
import { fetchClobMarkets, getClobPrices } from '@/lib/polymarket-clob';
import { matchOutcomes, calculateAllArbitrages, parseDepth, computeApy, applyManualMatches } from '@/lib/matcher';
import { getDecoupledPairs, applyDecoupledPairs } from '@/lib/decoupled-pairs';
import { SavedMarket } from '@/lib/persistence';
import { withTimeout, chooseBestPmStructure } from '@/lib/scan-shared';

const KALSHI_TIMEOUT_MS = 3000;
const PM_TIMEOUT_MS = 3000;
const CLOB_TIMEOUT_MS = 1500;

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
  // BUG-035: skip upstream fetches entirely for expired markets
  const _expiryMs = market.expiryDate ? new Date(market.expiryDate).getTime() : 0;
  if (_expiryMs > 0 && _expiryMs <= Date.now()) {
    return {
      id: market.id,
      eventTitle: market.eventTitle,
      bestRoiPct: 0,
      bestProfit: 0,
      strategy: 'Expired',
      matchedCount: 0,
      kalshiCount: 0,
      pmCount: 0,
      scannedAt: new Date().toISOString(),
      totalStake: 0,
      allArbs: [],
      expiryDate: market.expiryDate,
    } as SingleRefreshResult;
  }
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

  const kalshiSeriesTicker = market.kalshiUrl ? extractKalshiSeriesFromUrl(market.kalshiUrl) : null;

  let [kalshiMarkets, pmEvent] = await Promise.all([
    (async () => {
      // BUG-07: Try multi-series fetch first to get ALL market types (Moneyline,
      // totals, spreads, etc.) — not just the one series in the URL.
      if (kalshiSeriesTicker) {
        try {
          const multi = await withTimeout(
            fetchKalshiMultiSeriesMarkets(kalshiTicker, kalshiSeriesTicker),
            KALSHI_TIMEOUT_MS * 2, 'Kalshi multi-series',
          );
          if (multi.markets.length > 0) return multi.markets;
        } catch (e: any) {
          if (e.message?.includes('timed out')) throw e;
        }
      }
      // Fallback: single event_ticker
      try {
        const m = await withTimeout(fetchKalshiEventMarkets(kalshiTicker), KALSHI_TIMEOUT_MS, 'Kalshi event markets');
        if (m.length > 0) return m;
      } catch (e: any) { if (e.message?.includes('timed out')) throw e; }
      // Fallback: series prefix
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

  // Filter Kalshi markets to the specific match within a multi-game event
  kalshiMarkets = filterKalshiMarketsToMatch(kalshiMarkets, extractKalshiMatchKey(market.kalshiUrl));

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
  // Fetch CLOB for ALL condition IDs — fetchClobMarkets has its own concurrency limiter (10 concurrent)
  let clobMap: Map<string, any>;
  try {
    const clobTimeout = Math.max(CLOB_TIMEOUT_MS, conditionIds.length * 2000);
    clobMap = await withTimeout(
      fetchClobMarkets(conditionIds),
      clobTimeout,
      'CLOB metadata',
    );
  } catch (e: any) {
    console.warn(`[refresh-single] CLOB metadata unavailable for ${market.eventTitle}: ${e.message}. Falling back to gamma prices.`);
    clobMap = new Map();
  }

  // Enrich markets with CLOB prices in PARALLEL (was sequential loop).
  // getClobPrices already uses the internal CLOB semaphore for book fetches.
  const pmMarkets: any[] = await Promise.all(
    pmMarketsRaw.map(async (m) => {
      const clob = clobMap.get(m.conditionId);
      if (!clob) return m;
      try {
        const live = await withTimeout(getClobPrices(clob), CLOB_TIMEOUT_MS, 'CLOB prices');
        if (!live) {
          // CLOB token prices remain useful for display, but without asks they
          // are non-executable and must not feed arbitrage calculation.
          const yes = clob.tokens?.find((t: { outcome?: string; price?: number }) => t.outcome === 'Yes')?.price ?? 0;
          const no = clob.tokens?.find((t: { outcome?: string; price?: number }) => t.outcome === 'No')?.price ?? 0;
          return {
            ...m,
            clobEmpty: true,
            outcomePrices: JSON.stringify([yes, no]),
            bestAsk: 0,
            bestBid: 0,
          };
        }
        return {
          ...m,
          outcomePrices: JSON.stringify([live.yesPrice.toFixed(6), live.noPrice.toFixed(6)]),
          bestBid: live.bestBid != null ? live.bestBid : m.bestBid,
          bestAsk: live.bestAsk != null ? live.bestAsk : m.bestAsk,
          lastTradePrice: live.lastTradePrice,
          noAskDepth: Number(m.liquidityNum ?? m.liquidity ?? 0),
        };
      } catch (e: any) {
        console.warn(`[refresh-single] CLOB timeout for ${market.eventTitle}: ${e.message}`);
        return m;
      }
    }),
  );

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

  const positiveArbs = withArbitrage.filter(o => o.arbitrage && o.arbitrage.roiPct > 0 && !o.arbitrage.suspicious);
  // UI-03: Track best net arb (positive OR negative) for display.
  const netArbs = withArbitrage.filter(o => o.arbitrage && o.arbitrage.strategy !== 'No arb' && !o.arbitrage.suspicious);
  const bestNetArb = netArbs.length > 0
    ? netArbs.reduce((best, o) => o.arbitrage!.roiPct > best.arbitrage!.roiPct ? o : best)
    : null;
  const bestArb = positiveArbs.length > 0
    ? positiveArbs.reduce((best, o) => o.arbitrage!.roiPct > best.arbitrage!.roiPct ? o : best)
    : null;

  return {
    id: market.id,
    eventTitle: market.eventTitle,
    bestRoiPct: bestNetArb ? bestNetArb.arbitrage!.roiPct : 0,
    bestProfit: bestNetArb ? bestNetArb.arbitrage!.expectedProfit : 0,
    strategy: bestNetArb ? bestNetArb.arbitrage!.strategy : 'No arb',
    matchedCount,
    kalshiCount,
    pmCount,
    scannedAt: new Date().toISOString(),
    totalStake: bestNetArb ? (bestNetArb.arbitrage!.kalshiStake ?? 0) + (bestNetArb.arbitrage!.pmStake ?? 0) : 0,
    expiryDate: pmEvent.endDate,
    allArbs: netArbs.map(o => ({
      artist: o.artist,
      roiPct: o.arbitrage!.roiPct,
      expectedProfit: o.arbitrage!.expectedProfit,
      strategy: o.arbitrage!.strategy,
      totalStake: (o.arbitrage!.kalshiStake ?? 0) + (o.arbitrage!.pmStake ?? 0),
      kalshiTicker: o.kalshi?.ticker,
      kalshiYesAsk: o.kalshi?.yesAsk,
      kalshiNoAsk: o.kalshi?.noAsk,
      kalshiYesBid: o.kalshi?.yesBid,
      kalshiNoBid: o.kalshi?.noBid,
      pmConditionId: o.polymarket?.conditionId,
      pmYesPrice: o.polymarket?.yesPrice,
      pmNoPrice: o.polymarket?.noPrice,
      pmBestBid: o.polymarket?.bestBid,
      pmBestAsk: o.polymarket?.bestAsk,
      kalshiStake: o.arbitrage!.kalshiStake,
      pmStake: o.arbitrage!.pmStake,
      apyPct: o.arbitrage!.apyPct,
      buyPlatform: o.arbitrage!.buyPlatform,
      buyPrice: o.arbitrage!.buyPrice,
      sellPlatform: o.arbitrage!.sellPlatform,
      sellPrice: o.arbitrage!.sellPrice,
      fees: o.arbitrage!.fees,
    })),
  };
}
