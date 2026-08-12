/**
 * Quick-prices scan path — lightweight price refresh for a single saved market.
 *
 * Skips the heavy parts of /api/scan:
 *  - no multi-series Kalshi discovery
 *  - no per-condition CLOB metadata requests; standard markets use Gamma's
 *    aggregate CLOB quotes and neg-risk token books use one batch request
 *  - no CLOB depth fetching (prices only)
 *  - no DB writes, no arb lifecycle tracking, no Telegram alerts
 *
 * Returns the same outcome shape as /api/scan so the UI can merge it in-place.
 */

import {
  extractKalshiEventTicker,
  extractKalshiMatchKey,
  filterKalshiMarketsToMatch,
  fetchKalshiEventMarkets,
  type KalshiMarket,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl, PMMarket } from '@/lib/polymarket';
import { ClobMarket, fetchClobBooks, getClobPricesFromBooks } from '@/lib/polymarket-clob';
import {
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
import type { UnmatchedKalshi, UnmatchedPolymarket } from '@/app/lib/page-shared';
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
  matchStatus: 'unavailable' | 'confirmed_zero' | 'matched';
  matchError?: string;
  matchedPairs: { artist: string; kalshiTicker: string; pmConditionId: string }[];
  kalshiRawCount: number;
  pmRawCount: number;
  pmFilteredCount: number;
  outcomes: UnifiedOutcome[];
  unmatchedKalshi: UnmatchedKalshi[];
  unmatchedPolymarket: UnmatchedPolymarket[];
  expired: boolean;
  priceResolved: boolean;
  _ts: number;
  _kalshiFetchedAt: string;
  _pmFetchedAt: string;
  /** Bounded upstream failures. A non-empty list means cached/partial data is still usable. */
  platformWarnings: string[];
}

const KALSHI_TIMEOUT_WARNING = 'Kalshi timed out; showing available Polymarket data and saved market data.';
const KALSHI_UNAVAILABLE_WARNING = 'Kalshi returned no open markets; showing available Polymarket data and saved market data.';
const PM_UNAVAILABLE_WARNING = 'Polymarket event is unavailable or no longer open; showing available Kalshi and saved market data.';
const CLOB_TIMEOUT_WARNING = 'Polymarket order books timed out; showing saved market structure without live Polymarket prices.';

function unavailableQuickPmMarkets(markets: PMMarket[]): PMMarket[] {
  return markets.map((market) => ({
    ...market,
    clobEmpty: true,
    outcomePrices: '[0,0]',
    bestAsk: 0,
    bestBid: 0,
  }));
}

function parseStringArray(serialized: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(serialized || '[]');
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function quickClobMarket(market: PMMarket): ClobMarket | null {
  const outcomes = parseStringArray(market.outcomes);
  const tokenIds = parseStringArray(market.clobTokenIds);
  if (outcomes.length !== tokenIds.length || outcomes.length === 0 ||
      tokenIds.some((tokenId) => tokenId.trim() === '') ||
      new Set(tokenIds).size !== tokenIds.length) return null;

  const tokens = outcomes.map((outcome, index) => ({ token_id: tokenIds[index], outcome }));
  if (!tokens.some((token) => token.outcome.toLowerCase() === 'yes') ||
      !tokens.some((token) => token.outcome.toLowerCase() === 'no')) return null;

  return {
    condition_id: market.conditionId,
    best_bid: market.bestBid,
    best_ask: market.bestAsk,
    last_trade_price: market.lastTradePrice,
    closed: market.closed,
    active: market.active,
    neg_risk: market.negRisk === true || market.neg_risk === true,
    tokens,
  };
}

/** Enrich Gamma markets with executable CLOB quotes using one batch book call. */
export async function enrichQuickPmMarketsWithClobPrices(markets: PMMarket[]): Promise<PMMarket[]> {
  const clobMarkets = markets.map(quickClobMarket);
  const tokenIds = clobMarkets.flatMap((clob) => {
    if (!clob) return [];
    const isExecutable = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
    const hasAggregateQuotes = clob.neg_risk !== true &&
      isExecutable(clob.best_bid) && isExecutable(clob.best_ask);
    return hasAggregateQuotes ? [] : clob.tokens.map((token) => token.token_id);
  });
  const books = await fetchClobBooks(tokenIds);

  return markets.map((market, index) => {
    const clob = clobMarkets[index];
    if (!clob) {
      return { ...market, clobEmpty: true, outcomePrices: '[0,0]', bestAsk: 0, bestBid: 0 };
    }
    const yesToken = clob.tokens.find((token) => token.outcome.toLowerCase() === 'yes');
    const noToken = clob.tokens.find((token) => token.outcome.toLowerCase() === 'no');
    const live = getClobPricesFromBooks(
      clob,
      yesToken ? books.get(yesToken.token_id) ?? null : null,
      noToken ? books.get(noToken.token_id) ?? null : null,
    );
    if (!live) {
      return { ...market, clobEmpty: true, outcomePrices: '[0,0]', bestAsk: 0, bestBid: 0 };
    }
    return {
      ...market,
      outcomePrices: JSON.stringify([live.yesPrice.toFixed(6), live.noPrice.toFixed(6)]),
      bestBid: live.bestBid,
      bestAsk: live.bestAsk,
      lastTradePrice: live.lastTradePrice,
      neg_risk: clob.neg_risk,
    };
  });
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

  const platformWarnings: string[] = [];
  const [kalshiResult, pmEvent, manualMatches, decoupledPairs] = await Promise.all([
    withTimeout(fetchKalshiEventMarkets(kalshiTicker), QUICK_KALSHI_TIMEOUT_MS, 'Kalshi event markets').catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      platformWarnings.push(message.includes('timed out') ? KALSHI_TIMEOUT_WARNING : KALSHI_UNAVAILABLE_WARNING);
      return [] as KalshiMarket[];
    }),
    withTimeout(
      isPolymarketMarketUrl(polymarketUrl)
        ? fetchPolymarketMarketAsEvent(pmSlug)
        : fetchPolymarketEvent(pmSlug),
      QUICK_PM_TIMEOUT_MS,
      'Polymarket event',
    ).catch(() => {
      platformWarnings.push(PM_UNAVAILABLE_WARNING);
      return null;
    }),
    getManualMatches(),
    getDecoupledPairs(),
  ]);

  const kalshiMarkets = filterKalshiMarketsToMatch(kalshiResult, extractKalshiMatchKey(kalshiUrl));

  if (kalshiMarkets.length === 0 && !platformWarnings.some((warning) => warning.startsWith('Kalshi'))) {
    platformWarnings.push(KALSHI_UNAVAILABLE_WARNING);
  }
  if (!pmEvent && !platformWarnings.includes(PM_UNAVAILABLE_WARNING)) {
    platformWarnings.push(PM_UNAVAILABLE_WARNING);
  }

  const expiryDate = pmEvent?.endDate ?? market.expiryDate ?? undefined;

  const rawGroupTitle = pmEvent?.markets?.[0]?.groupItemTitle;
  const eventTitle = pmEvent?.title || market.eventTitle;
  const scanCategory = market.category || resolveMarketDomain(eventTitle, rawGroupTitle);

  const pmRawCount = (pmEvent?.markets || []).length;
  const pmMarketsRaw = chooseBestPmStructure(pmEvent?.markets || [], kalshiMarkets, eventTitle);
  const pmFilteredCount = pmMarketsRaw.length;

  const pmMarkets = await withTimeout(
    enrichQuickPmMarketsWithClobPrices(pmMarketsRaw),
    QUICK_PM_TIMEOUT_MS,
    'CLOB quick prices',
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    platformWarnings.push(message.includes('timed out')
      ? CLOB_TIMEOUT_WARNING
      : 'Polymarket order books are unavailable; showing saved market structure without live Polymarket prices.');
    return unavailableQuickPmMarkets(pmMarketsRaw);
  });

  const kalshiRawCount = kalshiMarkets.length;
  const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, eventTitle, capital, expiryDate);
  const matchedOutcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, capital, expiryDate);
  const splitOutcomes = applyDecoupledPairs(matchedOutcomes as unknown as UnifiedOutcome[], decoupledPairs);

  const suspRoi = await getSetting<number>('scanner.suspiciousRoiPct').catch(() => null);
  if (suspRoi != null) setSuspiciousRoiPct(suspRoi);

  const withArbitrage = calculateAllArbitrages(splitOutcomes, eventTitle, capital).map((o) => ({
    ...o,
    arbitrage: {
      ...o.arbitrage,
      apyPct: computeApy(o.arbitrage.roiPct, expiryDate),
    },
  }));

  const priceResolved = computePriceResolved(
    withArbitrage.map((o) => ({
      kalshi: o.kalshi ? { yesAsk: o.kalshi.yesAsk, noAsk: o.kalshi.noAsk } : null,
      polymarket: o.polymarket ? { yesPrice: o.polymarket.yesPrice, noPrice: o.polymarket.noPrice } : null,
    })),
  );

  const pmClosed = Boolean(pmEvent?.closed) && !pmEvent?.active;
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
  const matchedPairs = withArbitrage
    .filter((o) => o.kalshi && o.polymarket)
    .map((o) => ({ artist: o.artist, kalshiTicker: o.kalshi!.ticker, pmConditionId: o.polymarket!.conditionId }));
  const matchError = platformWarnings.length > 0 ? platformWarnings.join(' ') : undefined;
  const matchStatus = matchError ? 'unavailable' : matchedCount > 0 ? 'matched' : 'confirmed_zero';

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
    eventTitle,
    category: scanCategory,
    kalshiEventTicker: kalshiTicker,
    pmEventSlug: pmSlug,
    pmEventId: pmEvent?.id,
    expiryDate,
    kalshiCount,
    pmCount,
    matchedCount,
    matchStatus,
    matchError,
    matchedPairs,
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
    platformWarnings,
  };
}
