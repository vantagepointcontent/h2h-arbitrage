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
import {
  ClobMarket,
  fetchClobBooks,
  fetchClobBooksDetailed,
  getClobPricesFromBooks,
  type ClobBookFetchDiagnostic,
  type ClobBooksDetailedResult,
} from '@/lib/polymarket-clob';
import {
  matchOutcomes,
  calculateAllArbitrages,
  attachOutcomeContingentApy,
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
  _priceDataObservedAt: string | null;
  refreshLifecycle: {
    requestedAt: string;
    structureFetchedAt: string | null;
    completedAt: string;
  };
  pmRefresh: QuickPmRefresh;
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
  clob: ClobBooksDetailedResult['metrics'];
}

export interface QuickPricesPlatformDiagnostic {
  status: 'fresh' | 'partial' | 'empty' | 'failed';
  count: number;
  reason?: string;
}

export interface QuickPmOutcomeRefresh {
  conditionId: string;
  outcome: string;
  tokenIds: string[];
  status: 'refreshed' | 'timed_out' | 'error' | 'unavailable';
  observedAt: string | null;
  source: 'live-clob' | 'saved-market-snapshot' | null;
  servedFromSnapshot: boolean;
  snapshotAgeMs: number | null;
  reason?: string;
  tokens: ClobBookFetchDiagnostic[];
}

export interface QuickPmRefresh {
  outcomes: QuickPmOutcomeRefresh[];
  refreshedCount: number;
  timedOutCount: number;
  errorCount: number;
  unavailableCount: number;
  snapshotCount: number;
}

const KALSHI_TIMEOUT_WARNING = 'Kalshi timed out; showing available Polymarket data and saved market data.';
const KALSHI_EMPTY_WARNING = 'Kalshi linked event returned zero open markets.';
const PM_UNAVAILABLE_WARNING = 'Polymarket event is unavailable or no longer open; showing available Kalshi and saved market data.';


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

type SavedPmQuote = {
  pmConditionId?: string;
  pmYesPrice?: number;
  pmNoPrice?: number;
  pmBestBid?: number;
  pmBestAsk?: number;
  pmYesDepth?: number | null;
  pmNoDepth?: number | null;
};

/** Enrich exact matched token books independently and retain scoped failures. */
async function enrichQuickPmMarketsWithClobPricesDetailed(
  markets: PMMarket[],
  savedQuotes: SavedPmQuote[] = [],
  savedObservedAt: string | null = null,
): Promise<{ markets: PMMarket[]; refresh: QuickPmRefresh; metrics: ClobBooksDetailedResult['metrics'] }> {
  const clobMarkets = markets.map(quickClobMarket);
  const tokenIds = clobMarkets.flatMap((clob) =>
    clob ? clob.tokens.map((token) => token.token_id) : []);
  const detailed = await fetchClobBooksDetailed(tokenIds, {
    bypassCache: true, concurrency: 4, maxAttempts: 2,
    requestTimeoutMs: 3_500, retryBackoffMs: 250, totalDeadlineMs: 12_000,
  });
  const savedByCondition = new Map(savedQuotes
    .filter((quote) => typeof quote.pmConditionId === 'string')
    .map((quote) => [quote.pmConditionId!.toLowerCase(), quote]));
  const refreshOutcomes: QuickPmOutcomeRefresh[] = [];

  const enriched = markets.map((market, index) => {
    const clob = clobMarkets[index];
    if (!clob) {
      refreshOutcomes.push({
        conditionId: market.conditionId, outcome: market.groupItemTitle || market.question,
        tokenIds: [], status: 'unavailable', observedAt: null, source: null,
        servedFromSnapshot: false, snapshotAgeMs: null, reason: 'missing or malformed exact token identifiers', tokens: [],
      });
      return { ...market, clobEmpty: true, outcomePrices: '[0,0]', bestAsk: 0, bestBid: 0 };
    }
    const yesToken = clob.tokens.find((token) => token.outcome.toLowerCase() === 'yes');
    const noToken = clob.tokens.find((token) => token.outcome.toLowerCase() === 'no');
    const tokenDiagnostics = clob.tokens
      .map((token) => detailed.diagnostics.get(token.token_id))
      .filter((diagnostic): diagnostic is ClobBookFetchDiagnostic => diagnostic != null);
    // A derived complementary quote can keep display continuity for standard
    // binaries, but it cannot make a failed exact token request fresh. This is
    // especially critical for neg-risk markets where YES and NO are independent.
    const allRequiredBooksFresh = tokenDiagnostics.length === clob.tokens.length
      && tokenDiagnostics.every((diagnostic) => diagnostic.status === 'success');
    const live = getClobPricesFromBooks(
      clob,
      yesToken ? detailed.books.get(yesToken.token_id) ?? null : null,
      noToken ? detailed.books.get(noToken.token_id) ?? null : null,
    );
    if (!live || !allRequiredBooksFresh) {
      const status: QuickPmOutcomeRefresh['status'] = tokenDiagnostics.some((item) => item.status === 'timeout')
        ? 'timed_out' : tokenDiagnostics.some((item) => item.status === 'error') ? 'error' : 'unavailable';
      const saved = savedByCondition.get(market.conditionId.toLowerCase());
      const hasSaved = saved != null && typeof saved.pmYesPrice === 'number' && saved.pmYesPrice > 0
        && typeof saved.pmNoPrice === 'number' && saved.pmNoPrice > 0;
      const snapshotAgeMs = hasSaved && savedObservedAt && Number.isFinite(Date.parse(savedObservedAt))
        ? Math.max(0, Date.now() - Date.parse(savedObservedAt)) : null;
      const reason = tokenDiagnostics.length > 0
        ? tokenDiagnostics.filter((item) => item.status !== 'success')
          .map((item) => `${item.tokenId}: ${item.reason ?? item.status}`).join('; ')
        : 'required YES/NO token book unavailable';
      refreshOutcomes.push({
        conditionId: market.conditionId, outcome: market.groupItemTitle || market.question,
        tokenIds: clob.tokens.map((token) => token.token_id), status,
        observedAt: hasSaved ? savedObservedAt : null,
        source: hasSaved ? 'saved-market-snapshot' : null,
        servedFromSnapshot: hasSaved, snapshotAgeMs, reason, tokens: tokenDiagnostics,
      });
      return hasSaved ? {
        ...market, clobEmpty: true,
        outcomePrices: JSON.stringify([saved.pmYesPrice, saved.pmNoPrice]),
        bestAsk: saved.pmBestAsk ?? saved.pmYesPrice,
        bestBid: saved.pmBestBid ?? 0,
        askDepth: 0, noAskDepth: 0, quoteObservedAt: savedObservedAt ?? undefined,
      } : { ...market, clobEmpty: true, outcomePrices: '[0,0]', bestAsk: 0, bestBid: 0 };
    }
    const observedAt = tokenDiagnostics
      .map((item) => item.observedAt).filter((value): value is string => value != null)
      .sort()[0] ?? new Date().toISOString();
    refreshOutcomes.push({
      conditionId: market.conditionId, outcome: market.groupItemTitle || market.question,
      tokenIds: clob.tokens.map((token) => token.token_id), status: 'refreshed', observedAt,
      source: 'live-clob', servedFromSnapshot: false, snapshotAgeMs: 0, tokens: tokenDiagnostics,
    });
    return {
      ...market,
      outcomePrices: JSON.stringify([live.yesPrice.toFixed(6), live.noPrice.toFixed(6)]),
      bestBid: live.bestBid,
      bestAsk: live.bestAsk,
      lastTradePrice: live.lastTradePrice,
      askDepth: live.yesAskDepth ?? 0,
      noAskDepth: live.noAskDepth ?? 0,
      yesBid: live.yesBid,
      noBid: live.noBid,
      yesBidDepth: live.yesBidDepth,
      noBidDepth: live.noBidDepth,
      yesMinOrderSize: live.yesMinOrderSize ?? null,
      noMinOrderSize: live.noMinOrderSize ?? null,
      yesTickSize: live.yesTickSize ?? null,
      noTickSize: live.noTickSize ?? null,
      quoteObservedAt: observedAt,
      neg_risk: clob.neg_risk,
    };
  });
  return {
    markets: enriched,
    refresh: {
      outcomes: refreshOutcomes,
      refreshedCount: refreshOutcomes.filter((item) => item.status === 'refreshed').length,
      timedOutCount: refreshOutcomes.filter((item) => item.status === 'timed_out').length,
      errorCount: refreshOutcomes.filter((item) => item.status === 'error').length,
      unavailableCount: refreshOutcomes.filter((item) => item.status === 'unavailable').length,
      snapshotCount: refreshOutcomes.filter((item) => item.servedFromSnapshot).length,
    },
    metrics: detailed.metrics,
  };
}

/** Backwards-compatible market-only projection used by focused price tests. */
export async function enrichQuickPmMarketsWithClobPrices(markets: PMMarket[]): Promise<PMMarket[]> {
  const clobMarkets = markets.map(quickClobMarket);
  const tokenIds = clobMarkets.flatMap((clob) => clob ? clob.tokens.map((token) => token.token_id) : []);
  const books = await fetchClobBooks(tokenIds, { throwOnFailure: true, bypassCache: true });
  if (tokenIds.length > 0 && tokenIds.every((tokenId) => books.get(tokenId) == null)) {
    throw new Error('Polymarket CLOB returned no order books for the linked event');
  }
  return markets.map((market, index) => {
    const clob = clobMarkets[index];
    if (!clob) return { ...market, clobEmpty: true, outcomePrices: '[0,0]', bestAsk: 0, bestBid: 0 };
    const yesToken = clob.tokens.find((token) => token.outcome.toLowerCase() === 'yes');
    const noToken = clob.tokens.find((token) => token.outcome.toLowerCase() === 'no');
    const live = getClobPricesFromBooks(
      clob,
      yesToken ? books.get(yesToken.token_id) ?? null : null,
      noToken ? books.get(noToken.token_id) ?? null : null,
    );
    if (!live) return { ...market, clobEmpty: true, outcomePrices: '[0,0]', bestAsk: 0, bestBid: 0 };
    return {
      ...market,
      outcomePrices: JSON.stringify([live.yesPrice.toFixed(6), live.noPrice.toFixed(6)]),
      bestBid: live.bestBid, bestAsk: live.bestAsk, lastTradePrice: live.lastTradePrice,
      askDepth: live.yesAskDepth ?? 0, noAskDepth: live.noAskDepth ?? 0,
      yesBid: live.yesBid, noBid: live.noBid,
      yesBidDepth: live.yesBidDepth, noBidDepth: live.noBidDepth,
      yesMinOrderSize: live.yesMinOrderSize ?? null, noMinOrderSize: live.noMinOrderSize ?? null,
      yesTickSize: live.yesTickSize ?? null, noTickSize: live.noTickSize ?? null,
      neg_risk: clob.neg_risk,
    };
  });
}

export async function quickPricesScan(marketId: string, capital = 1000): Promise<QuickPricesResult> {
  const totalStartedAt = performance.now();
  const requestedAt = new Date().toISOString();
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
  let kalshiFetchedAt: string | null = null;
  let pmStructureFetchedAt: string | null = null;
  const linkedEventsStartedAt = performance.now();
  const [kalshiSettled, pmSettled, manualMatches, decoupledPairs] = await Promise.all([
    (() => {
      const startedAt = performance.now();
      return withTimeout(fetchKalshiEventMarkets(kalshiTicker), QUICK_KALSHI_TIMEOUT_MS, 'Kalshi event markets')
      .then((value) => {
        kalshiFetchedAt = new Date().toISOString();
        return { ok: true as const, value };
      })
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
      ).then((value) => {
        if (value) pmStructureFetchedAt = new Date().toISOString();
        return { ok: true as const, value };
      })
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

  const clobStartedAt = performance.now();
  const emptyClobMetrics: ClobBooksDetailedResult['metrics'] = {
    tokenCount: 0, successCount: 0, timeoutCount: 0, errorCount: 0,
    unavailableCount: 0, retryCount: 0, queueWaitMs: 0, upstreamLatencyMs: 0, durationMs: 0,
  };
  const pmEnrichment = await enrichQuickPmMarketsWithClobPricesDetailed(
    pmMarketsRaw,
    market.lastScanResult?.allArbs ?? [],
    market.lastScanResult?.scannedAt ?? null,
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      markets: unavailableQuickPmMarkets(pmMarketsRaw),
      refresh: {
        outcomes: pmMarketsRaw.map((item): QuickPmOutcomeRefresh => ({
          conditionId: item.conditionId, outcome: item.groupItemTitle || item.question,
          tokenIds: parseStringArray(item.clobTokenIds), status: 'error', observedAt: null,
          source: null, servedFromSnapshot: false, snapshotAgeMs: null, reason: message, tokens: [],
        })),
        refreshedCount: 0, timedOutCount: 0, errorCount: pmMarketsRaw.length,
        unavailableCount: 0, snapshotCount: 0,
      },
      metrics: { ...emptyClobMetrics, tokenCount: pmMarketsRaw.length * 2, errorCount: pmMarketsRaw.length * 2 },
    };
  });
  const pmMarkets = pmEnrichment.markets;
  const pmRefresh = pmEnrichment.refresh;
  const affected = pmRefresh.outcomes.filter((item) => item.status !== 'refreshed');
  let clobFailureReason: string | undefined;
  if (affected.length > 0) {
    const identities = affected.map((item) => item.outcome).join(', ');
    const details = [
      pmRefresh.timedOutCount > 0 ? `${pmRefresh.timedOutCount} timed out` : null,
      pmRefresh.errorCount > 0 ? `${pmRefresh.errorCount} errored` : null,
      pmRefresh.unavailableCount > 0 ? `${pmRefresh.unavailableCount} unavailable` : null,
    ].filter(Boolean).join(', ');
    clobFailureReason = `${pmRefresh.refreshedCount} of ${pmRefresh.outcomes.length} Polymarket outcomes refreshed; ${details}: ${identities}.`
      + (pmRefresh.snapshotCount > 0 ? ` ${pmRefresh.snapshotCount} served from last-known snapshots.` : '')
      + ' Transient failures were retried per exact token. Refresh prices to try affected outcomes again.';
    platformWarnings.push(clobFailureReason);
  }
  const clobMs = Math.max(0, Math.round(performance.now() - clobStartedAt));

  const kalshiRawCount = kalshiResult.length;
  const matchingStartedAt = performance.now();
  const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, eventTitle, capital, expiryDate);
  const matchedOutcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, capital, expiryDate);
  const splitOutcomes = applyDecoupledPairs(matchedOutcomes as unknown as UnifiedOutcome[], decoupledPairs);

  const suspRoi = await getSetting<number>('scanner.suspiciousRoiPct').catch(() => null);
  if (suspRoi != null) setSuspiciousRoiPct(suspRoi);

  const calculated = attachOutcomeContingentApy(
    calculateAllArbitrages(splitOutcomes, eventTitle, capital),
    new Date().toISOString(),
    expiryDate,
  );
  const refreshByCondition = new Map(pmRefresh.outcomes.map((item) => [item.conditionId.toLowerCase(), item]));
  const withArbitrage = calculated.map((outcome) => {
    const refresh = outcome.polymarket
      ? refreshByCondition.get(outcome.polymarket.conditionId.toLowerCase())
      : undefined;
    if (!refresh || refresh.status === 'refreshed') return { ...outcome, polymarketStale: false, polymarketRefresh: refresh };
    return {
      ...outcome,
      polymarketStale: true,
      polymarketRefresh: refresh,
      arbitrage: {
        ...outcome.arbitrage, expectedProfit: 0, roiPct: 0, apyPct: 0,
        kalshiStake: 0, pmStake: 0, maxCapital: 0, depthVerified: false,
        strategy: 'Unavailable — stale Polymarket outcome',
      },
    };
  });

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
        ? { status: pmRefresh.refreshedCount > 0 ? 'partial' : 'failed', count: pmRefresh.refreshedCount, reason: clobFailureReason }
      : { status: 'fresh', count: pmMarkets.length },
  };
  const failedPlatforms = Object.values(platformDiagnostics).filter(({ status }) => status === 'failed').length;
  const hasPartialPlatform = Object.values(platformDiagnostics).some(({ status }) => status === 'partial');
  const refreshStatus = failedPlatforms === 2 ? 'failed' : failedPlatforms > 0 || hasPartialPlatform ? 'partial' : 'complete';
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
    clob: pmEnrichment.metrics,
  };

  const validPmObservationTimes = pmRefresh.outcomes
    .map((item) => item.observedAt).filter((value): value is string => value != null && Number.isFinite(Date.parse(value)));
  const polymarketFullyFresh = pmRefresh.outcomes.length > 0
    && pmRefresh.outcomes.every((item) => item.status === 'refreshed');
  // Match summaries retain prior allArbs when a refresh is unavailable. Include
  // the prior observation whenever any PM outcome is unresolved so unchanged
  // quotes cannot be rebased onto a sibling response or completion timestamp.
  if (!polymarketFullyFresh && market.lastScanResult?.scannedAt
      && Number.isFinite(Date.parse(market.lastScanResult.scannedAt))) {
    validPmObservationTimes.push(market.lastScanResult.scannedAt);
  }
  const priceDataObservedAt = validPmObservationTimes.length > 0 ? validPmObservationTimes.sort()[0] : null;
  const completedAt = new Date().toISOString();

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
    _kalshiFetchedAt: kalshiFetchedAt ?? completedAt,
    _pmFetchedAt: priceDataObservedAt ?? completedAt,
    _priceDataObservedAt: priceDataObservedAt,
    refreshLifecycle: {
      requestedAt,
      structureFetchedAt: pmStructureFetchedAt,
      completedAt,
    },
    pmRefresh,
    platformWarnings,
    refreshStatus,
    retryable: failedPlatforms > 0 || hasPartialPlatform,
    platformDiagnostics,
    refreshMetrics,
  };
}
