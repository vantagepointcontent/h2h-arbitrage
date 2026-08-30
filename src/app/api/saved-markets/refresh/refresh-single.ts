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
import { fetchClobMarkets, getClobAskDepths, getClobPrices } from '@/lib/polymarket-clob';
import { matchOutcomes, calculateAllArbitrages, parseDepth, attachOutcomeContingentApy, applyManualMatches, type UnifiedOutcome } from '@/lib/matcher';
import { getDecoupledPairs, applyDecoupledPairs } from '@/lib/decoupled-pairs';
import { SavedMarket } from '@/lib/persistence';
import { withTimeout, chooseBestPmStructure } from '@/lib/scan-shared';
import type { OutcomeContingentApy } from '@/lib/settlement-apy';
import { quoteOneShareFromTopAsk, type ExecutableBookQuote } from '@/lib/executable-book';
import { resolveCanonicalMarketExpiry } from '@/lib/canonical-market-expiry';
import {
  buildKalshiExecutableQuote,
  type KalshiQuoteSourceProvenance,
} from '@/lib/kalshi-executable-quote';

const KALSHI_TIMEOUT_MS = 3000;
const PM_TIMEOUT_MS = 3000;
const CLOB_TIMEOUT_MS = 1500;

export function buildRefreshKalshiExecutableQuote(
  kalshi: NonNullable<UnifiedOutcome['kalshi']> | null | undefined,
  side: 'yes' | 'no',
  depthTimestamp: string,
  source?: KalshiQuoteSourceProvenance,
): ExecutableBookQuote {
  return buildKalshiExecutableQuote(kalshi, side, depthTimestamp, source);
}

export interface SingleRefreshResult {
  id: string;
  eventTitle: string;
  bestRoiPct: number;
  bestProfit: number;
  strategy: string;
  matchedCount: number;
  matchStatus?: 'not_scanned' | 'unavailable' | 'confirmed_zero' | 'matched';
  matchError?: string;
  matchedPairs?: { artist: string; kalshiTicker: string; pmConditionId: string }[];
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
    kalshiYesDepth?: number | string | null;
    kalshiNoDepth?: number | string | null;
    pmYesDepth?: number | null;
    pmNoDepth?: number | null;
    fees?: any;
    apyPct?: number | null;
    outcomeApy?: OutcomeContingentApy;
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
  const kalshiFetchFailures: string[] = [];

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
          if (e.message?.includes('timed out')) throw new Error('kalshi_source_timeout: Kalshi source request timed out');
          kalshiFetchFailures.push(e instanceof Error ? e.message : String(e));
        }
      }
      // Fallback: single event_ticker
      try {
        const m = await withTimeout(fetchKalshiEventMarkets(kalshiTicker), KALSHI_TIMEOUT_MS, 'Kalshi event markets');
        if (m.length > 0) return m;
      } catch (e: any) {
        if (e.message?.includes('timed out')) throw new Error('kalshi_source_timeout: Kalshi source request timed out');
        kalshiFetchFailures.push(e instanceof Error ? e.message : String(e));
      }
      // Fallback: series prefix
      const seriesMatch = kalshiTicker.match(/^([A-Z]+)/);
      const seriesFallback = seriesMatch ? seriesMatch[1] : null;
      if (seriesFallback && seriesFallback !== kalshiTicker) {
        try {
          const m = await withTimeout(fetchKalshiSeriesMarkets(seriesFallback), KALSHI_TIMEOUT_MS, 'Kalshi series markets');
          if (m.length > 0) return m;
        } catch (e: any) {
          if (e.message?.includes('timed out')) throw new Error('kalshi_source_timeout: Kalshi source request timed out');
          kalshiFetchFailures.push(e instanceof Error ? e.message : String(e));
        }
      }
      try {
        const m = await withTimeout(fetchKalshiSeriesMarkets(kalshiTicker), KALSHI_TIMEOUT_MS, 'Kalshi series markets');
        if (m.length > 0) return m;
      } catch (e: any) {
        if (e.message?.includes('timed out')) throw new Error('kalshi_source_timeout: Kalshi source request timed out');
        kalshiFetchFailures.push(e instanceof Error ? e.message : String(e));
      }
      return [] as any[];
    })(),
    withTimeout(
      isPolymarketMarketUrl(market.polymarketUrl)
        ? fetchPolymarketMarketAsEvent(pmSlug)
        : fetchPolymarketEvent(pmSlug),
      PM_TIMEOUT_MS, 'Polymarket event',
    ),
  ]);

  const kalshiRawFetchedCount = kalshiMarkets.length;
  kalshiMarkets = filterKalshiMarketsToMatch(kalshiMarkets, extractKalshiMatchKey(market.kalshiUrl));
  if (kalshiMarkets.length === 0) {
    if (kalshiRawFetchedCount > 0) {
      throw new Error(`kalshi_wrong_ticker: Kalshi returned ${kalshiRawFetchedCount} market(s), but matched no market for the requested ticker/outcome`);
    }
    if (kalshiFetchFailures.length > 0) {
      const detail = [...new Set(kalshiFetchFailures)].join('; ');
      const reason = kalshiFetchFailures.some(message => /(?:^|\D)429(?:\D|$)/.test(message))
        ? 'kalshi_source_rate_limited'
        : 'kalshi_source_unavailable';
      throw new Error(`${reason}: Kalshi source attempts failed: ${detail}`);
    }
    throw new Error('kalshi_market_data_unavailable: Kalshi returned no open market data');
  }

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

  const expiryResolution = resolveCanonicalMarketExpiry({
    polymarketEndDate: pmEvent.endDate,
    polymarketEventSlug: pmSlug,
    polymarketClosed: pmEvent.closed,
    polymarketMarkets: pmEvent.markets,
    kalshiMarkets,
  });
  const expiryDate = expiryResolution?.expiryAt ?? market.expiryDate ?? null;

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
        const [live, depth] = await withTimeout(
          Promise.all([getClobPrices(clob), getClobAskDepths(clob)]),
          CLOB_TIMEOUT_MS,
          'CLOB prices and depth',
        );
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
          // MF-001: use real CLOB ask-level quantity, never Gamma liquidity.
          askDepth: depth.yesAskDepth,
          noAskDepth: depth.noAskDepth,
          yesBid: depth.yesBid,
          noBid: depth.noBid,
          yesBidDepth: depth.yesBidDepth,
          noBidDepth: depth.noBidDepth,
          yesMinOrderSize: depth.yesMinOrderSize,
          noMinOrderSize: depth.noMinOrderSize,
          yesTickSize: depth.yesTickSize,
          noTickSize: depth.noTickSize,
        };
      } catch (e: any) {
        console.warn(`[refresh-single] CLOB timeout for ${market.eventTitle}: ${e.message}`);
        return m;
      }
    }),
  );

  const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent.title, 1000, expiryDate ?? undefined);
  const outcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, 1000, expiryDate ?? undefined);
  const decoupledPairs = await getDecoupledPairs();
  const splitOutcomes = applyDecoupledPairs(outcomes, decoupledPairs);

  const scannedAt = new Date().toISOString();
  const withArbitrage = attachOutcomeContingentApy(
    calculateAllArbitrages(splitOutcomes, market.category || pmEvent.title),
    scannedAt,
    expiryDate,
  );

  const kalshiCount = withArbitrage.filter(o => o.kalshi).length;
  const pmCount = withArbitrage.filter(o => o.polymarket).length;
  const matchedCount = withArbitrage.filter(o => o.kalshi && o.polymarket).length;
  const matchedPairs = withArbitrage
    .filter(o => o.kalshi && o.polymarket)
    .map(o => ({ artist: o.artist, kalshiTicker: o.kalshi!.ticker, pmConditionId: o.polymarket!.conditionId }));

  // UI-03: Track best net arb (positive OR negative) for display.
  const netArbs = withArbitrage.filter(o => o.arbitrage && o.arbitrage.strategy !== 'No arb' && !o.arbitrage.suspicious);
  const bestNetArb = netArbs.length > 0
    ? netArbs.reduce((best, o) => o.arbitrage!.roiPct > best.arbitrage!.roiPct ? o : best)
    : null;

  return {
    id: market.id,
    eventTitle: market.eventTitle,
    bestRoiPct: bestNetArb ? bestNetArb.arbitrage!.roiPct : 0,
    bestProfit: bestNetArb ? bestNetArb.arbitrage!.expectedProfit : 0,
    strategy: bestNetArb ? bestNetArb.arbitrage!.strategy : 'No arb',
    matchedCount,
    matchStatus: matchedCount > 0 ? 'matched' : 'confirmed_zero',
    matchedPairs,
    kalshiCount,
    pmCount,
    scannedAt,
    totalStake: bestNetArb ? (bestNetArb.arbitrage!.kalshiStake ?? 0) + (bestNetArb.arbitrage!.pmStake ?? 0) : 0,
    expiryDate,
    allArbs: netArbs.map(o => {
      const selectedPmConditionId = o.arbitrage?.pmConditionId ?? o.polymarket?.conditionId;
      const selectedPmLeg = withArbitrage.find(candidate => candidate.polymarket?.conditionId === selectedPmConditionId)?.polymarket ?? o.polymarket;
      return {
      artist: o.artist,
      kalshiMarketQuestion: o.arbitrage!.selectedKalshiMarketQuestion ?? o.kalshiMarketQuestion ?? null,
      pmMarketQuestion: o.arbitrage!.selectedPmMarketQuestion ?? o.pmMarketQuestion ?? null,
      kalshiOutcomeLabel: o.arbitrage!.selectedKalshiOutcomeLabel ?? o.kalshiOutcomeLabel ?? null,
      pmOutcomeLabel: o.arbitrage!.selectedPmOutcomeLabel ?? o.pmOutcomeLabel ?? null,
      relationshipVerified: o.arbitrage!.selectedRelationshipState === 'verified_complementary',
      relationshipState: o.arbitrage!.selectedRelationshipState,
      relationshipExplanation: o.arbitrage!.selectedRelationshipExplanation ?? null,
      kalshiSide: o.arbitrage!.selectedKalshiSide,
      pmSide: o.arbitrage!.selectedPmSide,
      roiPct: o.arbitrage!.roiPct,
      expectedProfit: o.arbitrage!.expectedProfit,
      strategy: o.arbitrage!.strategy,
      arbType: o.arbitrage!.arbType ?? undefined,
      propositionRelationship: o.propositionRelationship ?? null,
      totalStake: (o.arbitrage!.kalshiStake ?? 0) + (o.arbitrage!.pmStake ?? 0),
      kalshiTicker: o.kalshi?.ticker,
      kalshiYesAsk: o.kalshi?.yesAsk,
      kalshiNoAsk: o.kalshi?.noAsk,
      kalshiYesBid: o.kalshi?.yesBid,
      kalshiNoBid: o.kalshi?.noBid,
      // Preserve executable best-ask dollar depth for BotTrader qualification.
      // Dropping these fields caused every refreshed candidate to arrive as $0.
      kalshiYesDepth: o.kalshi?.yesAskDepth,
      kalshiNoDepth: o.kalshi?.noAskDepth,
      pmConditionId: selectedPmConditionId,
      pmYesTokenId: selectedPmLeg?.yesTokenId,
      pmNoTokenId: selectedPmLeg?.noTokenId,
      kalshiYesExecutableQuote: buildRefreshKalshiExecutableQuote(o.kalshi, 'yes', scannedAt),
      kalshiNoExecutableQuote: buildRefreshKalshiExecutableQuote(o.kalshi, 'no', scannedAt),
      pmYesExecutableQuote: quoteOneShareFromTopAsk({
        price: selectedPmLeg?.yesPrice, depthUsd: selectedPmLeg?.askDepth,
        tickSize: selectedPmLeg?.yesTickSize, minimumOrderSize: selectedPmLeg?.yesMinOrderSize,
        depthTimestamp: scannedAt,
      }),
      pmNoExecutableQuote: quoteOneShareFromTopAsk({
        price: selectedPmLeg?.noPrice, depthUsd: selectedPmLeg?.noAskDepth,
        tickSize: selectedPmLeg?.noTickSize, minimumOrderSize: selectedPmLeg?.noMinOrderSize,
        depthTimestamp: scannedAt,
      }),
      pmYesPrice: selectedPmLeg?.yesPrice,
      pmNoPrice: selectedPmLeg?.noPrice,
      pmBestBid: selectedPmLeg?.bestBid,
      pmBestAsk: selectedPmLeg?.bestAsk,
      pmYesDepth: selectedPmLeg?.askDepth,
      pmNoDepth: selectedPmLeg?.noAskDepth,
      pmFeesEnabled: selectedPmLeg?.feesEnabled,
      pmFeeSchedule: selectedPmLeg?.feeSchedule,
      pmYesMinOrderSize: selectedPmLeg?.yesMinOrderSize ?? null,
      pmNoMinOrderSize: selectedPmLeg?.noMinOrderSize ?? null,
      pmYesTickSize: selectedPmLeg?.yesTickSize ?? null,
      pmNoTickSize: selectedPmLeg?.noTickSize ?? null,
      requestedContracts: o.arbitrage!.requestedContracts ?? 1,
      executionStatus: o.arbitrage!.executionStatus ?? 'unavailable',
      executionBlocker: o.arbitrage!.executionBlocker,
      kalshiStake: o.arbitrage!.kalshiStake,
      pmStake: o.arbitrage!.pmStake,
      apyPct: o.arbitrage!.apyPct,
      daysToExpiry: o.arbitrage!.daysToExpiry,
      expiryAt: o.arbitrage!.expiryAt,
      apyUnavailableReason: o.arbitrage!.apyUnavailableReason,
      outcomeApy: o.arbitrage!.outcomeApy,
      buyPlatform: o.arbitrage!.buyPlatform,
      buyPrice: o.arbitrage!.buyPrice,
      sellPlatform: o.arbitrage!.sellPlatform,
      sellPrice: o.arbitrage!.sellPrice,
      calculationEnvelope: o.arbitrage!.calculationEnvelope,
      fees: o.arbitrage!.fees,
    };
    }),
  };
}
