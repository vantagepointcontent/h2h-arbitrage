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
  refreshStatus: 'complete' | 'partial' | 'failed';
  retryable: boolean;
  platformDiagnostics: Record<'kalshi' | 'polymarket', QuickPricesPlatformDiagnostic>;
  refreshMetrics: QuickPricesRefreshMetrics;
}

export interface QuickPricesRefreshMetrics {
  latencyMs: {
    savedMarket: number;
    kalshi: number;
    polymarket: number;
    linkedEvents: number;
    clob: number;
    matching: number;
    total: number;
  };
  counts: {
    kalshiRaw: number;
    kalshiFiltered: number;
    polymarketRaw: number;
    polymarketFiltered: number;
    matched: number;
  };
}

export interface QuickPricesPlatformDiagnostic {
  status: 'fresh' | 'empty' | 'failed';
  count: number;
  reason?: string;
}

const KALSHI_TIMEOUT_WARNING = 'Kalshi timed out; showing available Polymarket data and saved market data.';
const KALSHI_EMPTY_WARNING = 'Kalshi linked event returned zero open markets.';
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
  // Prices and displayed depth must come from the same current refresh. Standard
  // markets may use valid aggregate quotes, but still need token books for
  // executable best-level depth; fetch every linked market's two token books.
  const tokenIds = clobMarkets.flatMap((clob) =>
    clob ? clob.tokens.map((token) => token.token_id) : []);
  const books = await fetchClobBooks(tokenIds, { throwOnFailure: true, bypassCache: true });

  if (tokenIds.length > 0 && tokenIds.every((tokenId) => books.get(tokenId) == null)) {
    throw new Error('Polymarket CLOB returned no order books for the linked event');
  }

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
      askDepth: live.yesAskDepth ?? 0,
      noAskDepth: live.noAskDepth ?? 0,
      neg_risk: clob.neg_risk,
    };
  });
}

export async function quickPricesScan(marketId: string, capital = 1000): Promise<QuickPricesResult> {
  const totalStartedAt = performance.now();
  const savedMarketStartedAt = performance.now();
  const market = await getSavedMarketById(marketId);
  const savedMarketMs = Math.max(0, Math.round(performance.now() - savedMarketStartedAt));
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
  let kalshiMs = 0;
  let polymarketMs = 0;
  const linkedEventsStartedAt = performance.now();
  const [kalshiSettled, pmSettled, manualMatches, decoupledPairs] = await Promise.all([
    (() => {
      const startedAt = performance.now();
      return withTimeout(fetchKalshiEventMarkets(kalshiTicker), QUICK_KALSHI_TIMEOUT_MS, 'Kalshi event markets')
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }))
      .finally(() => { kalshiMs = Math.max(0, Math.round(performance.now() - startedAt)); });
    })(),
    (() => {
      const startedAt = performance.now();
      return withTimeout(
        isPolymarketMarketUrl(polymarketUrl)
          ? fetchPolymarketMarketAsEvent(pmSlug)
          : fetchPolymarketEvent(pmSlug),
        QUICK_PM_TIMEOUT_MS,
        'Polymarket event',
      ).then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error }))
        .finally(() => { polymarketMs = Math.max(0, Math.round(performance.now() - startedAt)); });
    })(),
    getManualMatches(),
    getDecoupledPairs(),
  ]);
  const linkedEventsMs = Math.max(0, Math.round(performance.now() - linkedEventsStartedAt));

  const kalshiResult = kalshiSettled.ok ? kalshiSettled.value : [] as KalshiMarket[];
  const pmEvent = pmSettled.ok ? pmSettled.value : null;
  const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

  const kalshiMarkets = filterKalshiMarketsToMatch(kalshiResult, extractKalshiMatchKey(kalshiUrl));
  const kalshiReason = !kalshiSettled.ok
    ? (errorText(kalshiSettled.error).includes('timed out')
      ? KALSHI_TIMEOUT_WARNING
      : `Kalshi linked-event request failed: ${errorText(kalshiSettled.error)}`)
    : kalshiMarkets.length === 0 ? KALSHI_EMPTY_WARNING : undefined;
  const pmReason = !pmSettled.ok
    ? `Polymarket linked-event request failed: ${errorText(pmSettled.error)}`
    : !pmEvent ? PM_UNAVAILABLE_WARNING : undefined;
  if (kalshiReason) platformWarnings.push(kalshiReason);
  if (pmReason) platformWarnings.push(pmReason);

  const expiryDate = pmEvent?.endDate ?? market.expiryDate ?? undefined;

  const rawGroupTitle = pmEvent?.markets?.[0]?.groupItemTitle;
  const eventTitle = pmEvent?.title || market.eventTitle;
  const scanCategory = market.category || resolveMarketDomain(eventTitle, rawGroupTitle);

  const pmRawCount = (pmEvent?.markets || []).length;
  const pmMarketsRaw = chooseBestPmStructure(pmEvent?.markets || [], kalshiMarkets, eventTitle);
  const pmFilteredCount = pmMarketsRaw.length;

  let clobFailureReason: string | undefined;
  const clobStartedAt = performance.now();
  const pmMarkets = await withTimeout(
    enrichQuickPmMarketsWithClobPrices(pmMarketsRaw),
    QUICK_PM_TIMEOUT_MS,
    'CLOB quick prices',
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    clobFailureReason = message.includes('timed out')
      ? CLOB_TIMEOUT_WARNING
      : `Polymarket order books are unavailable: ${message}`;
    platformWarnings.push(clobFailureReason);
    return unavailableQuickPmMarkets(pmMarketsRaw);
  });
  const clobMs = Math.max(0, Math.round(performance.now() - clobStartedAt));

  const kalshiRawCount = kalshiResult.length;
  const matchingStartedAt = performance.now();
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
  const matchingMs = Math.max(0, Math.round(performance.now() - matchingStartedAt));
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

  const platformDiagnostics: QuickPricesResult['platformDiagnostics'] = {
    kalshi: kalshiReason
      ? { status: kalshiSettled.ok ? 'empty' : 'failed', count: 0, reason: kalshiReason }
      : { status: 'fresh', count: kalshiMarkets.length },
    polymarket: pmReason
      ? { status: pmSettled.ok ? 'empty' : 'failed', count: 0, reason: pmReason }
      : clobFailureReason
        ? { status: 'failed', count: pmMarkets.length, reason: clobFailureReason }
      : { status: 'fresh', count: pmMarkets.length },
  };
  const failedPlatforms = Object.values(platformDiagnostics).filter(({ status }) => status === 'failed').length;
  const refreshStatus = failedPlatforms === 2 ? 'failed' : failedPlatforms === 1 ? 'partial' : 'complete';
  const refreshMetrics: QuickPricesRefreshMetrics = {
    latencyMs: {
      savedMarket: savedMarketMs,
      kalshi: kalshiMs,
      polymarket: polymarketMs,
      linkedEvents: linkedEventsMs,
      clob: clobMs,
      matching: matchingMs,
      total: Math.max(0, Math.round(performance.now() - totalStartedAt)),
    },
    counts: {
      kalshiRaw: kalshiRawCount,
      kalshiFiltered: kalshiMarkets.length,
      polymarketRaw: pmRawCount,
      polymarketFiltered: pmFilteredCount,
      matched: matchedCount,
    },
  };

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
    refreshStatus,
    retryable: failedPlatforms > 0,
    platformDiagnostics,
    refreshMetrics,
  };
}
