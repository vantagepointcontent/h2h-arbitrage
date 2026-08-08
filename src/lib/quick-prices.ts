/**
 * Quick-prices scan path — lightweight price refresh for a single saved market.
 *
 * Skips the heavy parts of /api/scan:
 *  - no multi-series Kalshi discovery
 *  - no CLOB orderbook depth fetching (uses CLOB metadata best_bid/best_ask only)
 *  - no DB writes, no arb lifecycle tracking, no Telegram alerts
 *
 * Returns the same outcome shape as /api/scan so the UI can merge it in-place.
 */

import {
  extractKalshiEventTicker,
  extractKalshiMatchKey,
  filterKalshiMarketsToMatch,
  fetchKalshiEventMarkets,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl, parseOutcomePrices } from '@/lib/polymarket';
import { fetchClobMarkets, getClobPrices } from '@/lib/polymarket-clob';
import {
  buildKalshiArbShape,
  buildPmArbShape,
  matchOutcomes,
  calculateAllArbitrages,
  computeApy,
  applyManualMatches,
  setSuspiciousRoiPct,
  UnifiedOutcome,
} from '@/lib/matcher';
import { getSetting } from '@/lib/settings';
import { getManualMatches } from '@/lib/manual-matches';
import { getDecoupledPairs, applyDecoupledPairs } from '@/lib/decoupled-pairs';
import { getSavedMarketById } from '@/lib/persistence';
import { withTimeout, chooseBestPmStructure } from '@/lib/scan-shared';
import { computePriceResolved } from '@/app/lib/page-shared';
import { resolveMarketDomain } from './market-classification';

const QUICK_KALSHI_TIMEOUT_MS = 5000;
const QUICK_PM_TIMEOUT_MS = 5000;

export interface QuickPricesResult {
  eventTitle: string;
  category: string;
  kalshiEventTicker: string | null;
  pmEventSlug: string | null;
  pmEventId: string | undefined;
  expiryDate: string | undefined;
  kalshiCount: number;
  pmCount: number;
  matchedCount: number;
  kalshiRawCount: number;
  pmRawCount: number;
  pmFilteredCount: number;
  outcomes: UnifiedOutcome[];
  unmatchedKalshi: any[];
  unmatchedPolymarket: any[];
  expired: boolean;
  priceResolved: boolean;
  _ts: number;
  _kalshiFetchedAt: string;
  _pmFetchedAt: string;
}

export async function quickPricesScan(marketId: string, capital = 1000): Promise<QuickPricesResult> {
  const market = await getSavedMarketById(marketId);
  if (!market) {
    throw Object.assign(new Error('Market not found'), { status: 404 });
  }

  const kalshiUrl = market.kalshiUrl;
  const polymarketUrl = market.polymarketUrl;

  const kalshiTicker = extractKalshiEventTicker(kalshiUrl);
  const pmSlug = polymarketUrl ? extractPolymarketSlug(polymarketUrl) : null;

  if (!kalshiTicker) {
    throw Object.assign(new Error('A valid Kalshi market link is required.'), { status: 400 });
  }
  if (!pmSlug) {
    throw Object.assign(new Error('A valid Polymarket market link is required.'), { status: 400 });
  }

  let [kalshiMarkets, pmEvent, manualMatches, decoupledPairs] = await Promise.all([
    withTimeout(fetchKalshiEventMarkets(kalshiTicker), QUICK_KALSHI_TIMEOUT_MS, 'Kalshi event markets').catch((e: any) => {
      if (e.message?.includes('timed out')) throw e;
      return [] as any[];
    }),
    withTimeout(
      isPolymarketMarketUrl(polymarketUrl)
        ? fetchPolymarketMarketAsEvent(pmSlug)
        : fetchPolymarketEvent(pmSlug),
      QUICK_PM_TIMEOUT_MS,
      'Polymarket event',
    ).catch(() => null),
    getManualMatches(),
    getDecoupledPairs(),
  ]);

  kalshiMarkets = filterKalshiMarketsToMatch(kalshiMarkets, extractKalshiMatchKey(kalshiUrl));

  if (!pmEvent) {
    throw Object.assign(new Error('Polymarket event not found.'), { status: 404 });
  }

  const expiryDate = pmEvent.endDate;

  const rawGroupTitle = pmEvent.markets?.[0]?.groupItemTitle;
  const scanCategory = resolveMarketDomain(pmEvent.title, rawGroupTitle);

  const pmRawCount = (pmEvent.markets || []).length;
  const pmMarketsRaw = chooseBestPmStructure(pmEvent.markets || [], kalshiMarkets, pmEvent.title);
  const pmFilteredCount = pmMarketsRaw.length;

  const conditionIds = pmMarketsRaw.map((m: any) => m.conditionId).filter(Boolean) as string[];
  const clobTimeout = Math.max(QUICK_PM_TIMEOUT_MS, conditionIds.length * 500);
  let clobMap: Map<string, any>;
  try {
    clobMap = await withTimeout(fetchClobMarkets(conditionIds), clobTimeout, 'CLOB metadata');
  } catch {
    clobMap = new Map();
  }

  const clobMapLower = new Map<string, any>();
  for (const [key, val] of clobMap) {
    clobMapLower.set(key.toLowerCase(), val);
  }

  // Fast price enrichment: use CLOB metadata only; do not fetch token orderbooks for depth.
  // getClobPrices will still use token books as fallback when aggregate best_bid/best_ask is missing.
  const pmMarkets: any[] = await Promise.all(
    pmMarketsRaw.map(async (m) => {
      const clob = clobMapLower.get(m.conditionId?.toLowerCase()) ?? clobMap.get(m.conditionId);
      if (!clob) return m;
      try {
        const live = await getClobPrices(clob);
        if (!live) {
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
          neg_risk: clob.neg_risk,
        };
      } catch {
        return m;
      }
    }),
  );

  const kalshiRawCount = kalshiMarkets.length;
  const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent.title, capital, pmEvent.endDate);
  const matchedOutcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, capital, pmEvent.endDate);
  const splitOutcomes = applyDecoupledPairs(matchedOutcomes as unknown as UnifiedOutcome[], decoupledPairs);

  const suspRoi = await getSetting<number>('scanner.suspiciousRoiPct').catch(() => null);
  if (suspRoi != null) setSuspiciousRoiPct(suspRoi);

  const withArbitrage = calculateAllArbitrages(splitOutcomes, pmEvent.title, capital).map((o) => ({
    ...o,
    arbitrage: {
      ...o.arbitrage,
      apyPct: computeApy(o.arbitrage.roiPct, pmEvent.endDate),
    },
  }));

  const priceResolved = computePriceResolved(
    withArbitrage.map((o) => ({
      kalshi: o.kalshi ? { yesAsk: o.kalshi.yesAsk, noAsk: o.kalshi.noAsk } : null,
      polymarket: o.polymarket ? { yesPrice: o.polymarket.yesPrice, noPrice: o.polymarket.noPrice } : null,
    })),
  );

  const pmClosed = Boolean(pmEvent.closed) && !pmEvent.active;
  let expired = false;
  if (expiryDate) {
    const expiryMs = new Date(expiryDate).getTime();
    if (expiryMs > 0 && expiryMs <= Date.now()) {
      expired = priceResolved || pmClosed;
    }
  }

  const kalshiCount = withArbitrage.filter((o) => o.kalshi).length;
  const pmCount = withArbitrage.filter((o) => o.polymarket).length;
  const matchedCount = withArbitrage.filter((o) => o.kalshi && o.polymarket).length;

  const unmatchedKalshi = withArbitrage
    .filter((o) => o.kalshi && !o.polymarket)
    .map((o) => ({
      ticker: o.kalshi!.ticker,
      title: o.artist,
      artist: o.artist,
      yesAsk: o.kalshi!.yesAsk,
      noAsk: o.kalshi!.noAsk,
    }));

  const unmatchedPolymarket = withArbitrage
    .filter((o) => o.polymarket && !o.kalshi)
    .map((o) => ({
      conditionId: o.polymarket!.conditionId,
      marketId: o.polymarket!.marketId,
      title: o.artist,
      yesPrice: o.polymarket!.yesPrice,
      noPrice: o.polymarket!.noPrice,
    }));

  return {
    eventTitle: pmEvent.title,
    category: scanCategory,
    kalshiEventTicker: kalshiTicker,
    pmEventSlug: pmSlug,
    pmEventId: pmEvent.id,
    expiryDate,
    kalshiCount,
    pmCount,
    matchedCount,
    kalshiRawCount,
    pmRawCount,
    pmFilteredCount,
    outcomes: withArbitrage,
    unmatchedKalshi,
    unmatchedPolymarket,
    expired,
    priceResolved,
    _ts: Date.now(),
    _kalshiFetchedAt: new Date().toISOString(),
    _pmFetchedAt: new Date().toISOString(),
  };
}
