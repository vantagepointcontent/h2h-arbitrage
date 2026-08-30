import { NextRequest, NextResponse } from 'next/server';
import logger from '@/lib/logger';
import {
  extractKalshiEventTicker,
  extractKalshiSeriesFromUrl,
  extractKalshiMatchKey,
  filterKalshiMarketsToMatch,
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
  fetchKalshiMultiSeriesMarkets,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl, parseOutcomePrices } from '@/lib/polymarket';
import { fetchClobMarkets, getClobAskDepths, getClobPrices } from '@/lib/polymarket-clob';
import { buildKalshiArbShape, matchOutcomes, calculateAllArbitrages, parseDepth, attachOutcomeContingentApy, applyManualMatches, setSuspiciousRoiPct, UnifiedOutcome, type KalshiAskDepthStatus } from '@/lib/matcher';
import { resolveKalshiFeeAuthoritiesForMarkets } from '@/lib/kalshi-fee-quote';
import { getSetting } from '@/lib/settings';
import { getManualMatches } from '@/lib/manual-matches';
import { getDecoupledPairs, applyDecoupledPairs } from '@/lib/decoupled-pairs';
import { findSavedMarketByUrls, reconcileSavedMarketMatchSummary, reserveSavedMarketPublication, updateSavedMarketScanResult, appendScanHistory, isDormantMarketResult } from '@/lib/persistence';
import { persistAndConsumeBotScan } from '@/lib/bot-scan-consumer';
import { recordArbObservations } from '@/lib/arb-lifecycle';
import { sendBatchAlerts, ArbAlertInput } from '@/lib/telegram-alerts';
import { clientSafeError } from '@/lib/error-handler';
import { withTimeout, chooseBestPmStructure } from '@/lib/scan-shared';
import { computePriceResolved } from '@/app/lib/page-shared';
import { auditArbClassification } from '@/lib/arb-types';
import { quoteOneShareFromTopAsk, type ExecutableBookReason } from '@/lib/executable-book';
import { getUnavailableScanPlatforms, resolveScanLinks } from '@/lib/scan-links';
import { parseScanCapital } from '@/lib/scan-request';
import { parseJsonObject } from '@/lib/request-json';
import { resolveMarketDomain } from '@/lib/market-classification';
import { selectMatchedClobConditionIds } from '@/lib/scan-clob-selection';
import { withSqliteBusyRetry } from '@/lib/sqlite-write-retry';
import { persistPlatformPriceSnapshots, snapshotInputsFromOutcomes } from '@/lib/current-price-snapshots';
import { resolveCanonicalMarketExpiry } from '@/lib/canonical-market-expiry';
import {
  acquireSavedMarketScanLock,
  releaseSavedMarketScanLock,
  type SavedMarketScanLock,
} from '@/lib/saved-market-scan-lock';

const API_TIMEOUT_MS = 5000; // OPS-011: 5s timeout — was 15s, caused 17-29s total scan times
const KALSHI_MULTI_TIMEOUT_MS = 8000; // multi-series gets a bit more headroom
const DEBUG_H2H = process.env.DEBUG_H2H === '1' || process.env.DEBUG_H2H === 'true';

const DORMANT_REASON_CODES = new Set(['clob_book_empty', 'clob_metadata_incomplete']);

function kalshiDepthUnavailableReason(status: KalshiAskDepthStatus | undefined): Extract<ExecutableBookReason,
  'authoritative_empty' | 'missing_depth' | 'malformed_depth' | 'inactive_market'> | undefined {
  if (status === 'authoritative_empty') return 'authoritative_empty';
  if (status === 'missing') return 'missing_depth';
  if (status === 'malformed') return 'malformed_depth';
  if (status === 'inactive') return 'inactive_market';
  return undefined;
}

export async function executeFullScan(request: NextRequest) {
  const scanAttemptedAt = new Date().toISOString();
  let savedMarketId: string | null = null;
  let publicationGeneration: number | null = null;
  let fullScanPersisted = false;
  let scanLock: SavedMarketScanLock | null = null;
  const failIncompleteScan = async (reasonCode: string, detail: string, options?: { retainedCanonical?: boolean }) => {
    const error = `${reasonCode}: ${detail} The prior completed scan remains canonical.`;
    const dormant = DORMANT_REASON_CODES.has(reasonCode);
    if (savedMarketId && publicationGeneration != null) {
      const summary: Parameters<typeof reconcileSavedMarketMatchSummary>[1] = {
        matchedCount: 0,
        matchStatus: options?.retainedCanonical ? 'confirmed_zero' : 'unavailable',
        matchError: error,
        matchedPairs: undefined,
        scannedAt: new Date().toISOString(),
        publicationGeneration,
      };
      await reconcileSavedMarketMatchSummary(savedMarketId, summary).catch(() => {});
    }
    return NextResponse.json({ error, reasonCode, dormant, fullScanPersisted: false }, { status: 503 });
  };
  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const body: Record<string, any> = parsed.body;
    const { skipAutoMatch, force = false } = body;
    const capital = parseScanCapital(body.capital);
    if (capital === null) {
      return NextResponse.json(
        { error: 'Invalid capital. Expected a finite number from $1 to $1,000,000.' },
        { status: 400 },
      );
    }
    // FEAT-4: canonical platformLinks payload with legacy URL compatibility.
    const { platformLinks: suppliedLinks, kalshiUrl, polymarketUrl } = resolveScanLinks(body);
    const unavailablePlatforms = getUnavailableScanPlatforms(suppliedLinks);
    if (unavailablePlatforms.length > 0) {
      const names = unavailablePlatforms.map(platform => platform.name).join(', ');
      return NextResponse.json(
        { error: `${names} adapter not yet available. This link was recognized, but EdgeFinder cannot scan it yet.` },
        { status: 400 },
      );
    }

    const kalshiTicker = kalshiUrl ? extractKalshiEventTicker(kalshiUrl) : null;
    const pmSlug = polymarketUrl ? extractPolymarketSlug(polymarketUrl) : null;

    if (!kalshiTicker) {
      return NextResponse.json(
        { error: 'A valid Kalshi market link is required. Expected format: https://kalshi.com/markets/{series}/.../{ticker}' },
        { status: 400 }
      );
    }
    if (!pmSlug) {
      return NextResponse.json(
        { error: 'A valid Polymarket market link is required. Expected format: https://polymarket.com/event/{slug} or /sports/{path}' },
        { status: 400 }
      );
    }

    // Reserve ordering before upstream requests. Completion timestamps cannot
    // order overlapping scans that resolve within the same clock tick.
    const savedMarket = await findSavedMarketByUrls(kalshiUrl!, polymarketUrl!);
    savedMarketId = savedMarket?.id ?? null;
    if (savedMarketId) {
      const acquisition = await acquireSavedMarketScanLock(savedMarketId);
      if (acquisition.status === 'busy') {
        return NextResponse.json(
          {
            error: 'A full scan for this saved market is already in progress. Retry after it completes.',
            reason: acquisition.reason,
            detail: acquisition.detail,
          },
          {
            status: 409,
            headers: { 'Retry-After': String(Math.max(1, Math.ceil(acquisition.retryAfterMs / 1_000))) },
          },
        );
      }
      scanLock = acquisition.lock;
    }
    if (savedMarket) {
      publicationGeneration = await reserveSavedMarketPublication(savedMarket.id, 'scan');
      await reconcileSavedMarketMatchSummary(savedMarket.id, {
        matchedCount: 0,
        matchStatus: 'refreshing',
        matchError: undefined,
        matchedPairs: undefined,
        scannedAt: new Date().toISOString(),
        publicationGeneration,
      });
    }

    // BUG-05 Sub-Issue 3: Fetch markets from ALL related Kalshi series for the
    // same match. When the URL is for an "advances" market (KXWCADVANCE), we
    // also fetch Moneyline (KXWCGAME), totals (KXWCTOTAL), etc. by discovering
    // sibling series with the same sport prefix.
    const kalshiSeriesTicker = kalshiUrl ? extractKalshiSeriesFromUrl(kalshiUrl) : null;

    // Kalshi: try event_ticker first, fallback to series_ticker
    let kalshiFetchSource: 'event_ticker' | 'multi_series' | 'series_prefix' | 'series_ticker' | 'none' = 'none';
    let kalshiSeriesFetched: string[] = [];
    let [kalshiMarkets, pmEvent, manualMatches, decoupledPairs] = await Promise.all([
      (async () => {
        // First try the event_ticker from the URL
        try {
          const m = await withTimeout(fetchKalshiEventMarkets(kalshiTicker), API_TIMEOUT_MS, 'Kalshi event markets');
          if (m.length > 0) {
            // BUG-05 Sub-Issue 3: If we have a series ticker, fetch sibling
            // series (KXWCGAME, KXWCTOTAL, etc.) for the same match in parallel.
            if (kalshiSeriesTicker) {
              try {
                const multi = await withTimeout(
                  fetchKalshiMultiSeriesMarkets(kalshiTicker, kalshiSeriesTicker),
                  KALSHI_MULTI_TIMEOUT_MS, 'Kalshi multi-series',
                );
                console.log(`[scan] multi-series: ${multi.markets.length} markets from ${multi.seriesFetched.length} series (original: ${m.length})`, { seriesFetched: multi.seriesFetched });
                if (multi.markets.length > m.length) {
                  kalshiFetchSource = 'multi_series';
                  kalshiSeriesFetched = multi.seriesFetched;
                  return multi.markets;
                }
              } catch (e: any) {
                console.log(`[scan] multi-series failed:`, e.message);
                if (e.message?.includes('timed out')) throw e;
                // Multi-series failed (series API unavailable, etc.) — fall
                // through to single event_ticker result
              }
            }
            kalshiFetchSource = 'event_ticker';
            return m;
          }
        } catch (e: any) {
          if (e.message?.includes('timed out')) throw e;
        }
        const seriesMatch = kalshiTicker.match(/^([A-Z]+)/);
        const seriesFallback = seriesMatch ? seriesMatch[1] : null;
        if (seriesFallback && seriesFallback !== kalshiTicker) {
          try {
            const m = await withTimeout(fetchKalshiSeriesMarkets(seriesFallback), API_TIMEOUT_MS, 'Kalshi series markets');
            if (m.length > 0) {
              kalshiFetchSource = 'series_prefix';
              return m;
            }
          } catch (e: any) {
            if (e.message?.includes('timed out')) throw e;
          }
        }
        try {
          const m = await withTimeout(fetchKalshiSeriesMarkets(kalshiTicker), API_TIMEOUT_MS, 'Kalshi series markets');
          if (m.length > 0) {
            kalshiFetchSource = 'series_ticker';
            return m;
          }
        } catch (e: any) {
          if (e.message?.includes('timed out')) throw e;
        }
        return [] as any[];
      })(),
      withTimeout(
        isPolymarketMarketUrl(polymarketUrl!)
          ? fetchPolymarketMarketAsEvent(pmSlug)
          : fetchPolymarketEvent(pmSlug),
        API_TIMEOUT_MS, 'Polymarket event',
      ),
      getManualMatches(),
      getDecoupledPairs(),
    ]);

    // Filter Kalshi markets to the specific match within a multi-game event
    kalshiMarkets = filterKalshiMarketsToMatch(kalshiMarkets, extractKalshiMatchKey(kalshiUrl!));

    if (!pmEvent) {
      if (savedMarketId && publicationGeneration != null) {
        await reconcileSavedMarketMatchSummary(savedMarketId, {
          matchedCount: 0,
          matchStatus: 'unavailable',
          matchError: 'Polymarket event not found. The market may have closed or the URL may be incorrect.',
          matchedPairs: undefined,
          scannedAt: new Date().toISOString(),
          publicationGeneration,
        }).catch(() => {});
      }
      return NextResponse.json(
        { error: 'Polymarket event not found. The market may have closed or the URL may be incorrect.' },
        { status: 404 }
      );
    }

    const expiryResolution = resolveCanonicalMarketExpiry({
      polymarketEndDate: pmEvent.endDate,
      polymarketEventSlug: pmSlug,
      polymarketClosed: pmEvent.closed,
      polymarketMarkets: pmEvent.markets,
      kalshiMarkets,
    });
    // A previously persisted source remains usable when a transient venue
    // response cannot prove a replacement. Never clear it from a sparse scan.
    const expiryDate = expiryResolution?.expiryAt ?? savedMarket?.expiryDate ?? null;

    // groupItemTitle is often an outcome label ("Yes", a candidate name, etc.).
    // Only accept it when it is one of EdgeFinder's canonical domains.
    const rawGroupTitle = pmEvent.markets?.[0]?.groupItemTitle;
    const scanCategory = resolveMarketDomain(pmEvent.title, rawGroupTitle);

    // ---- LIVE CLOB ENRICHMENT: replace cached gamma prices with real orderbook prices ----
    const pmRawCount = (pmEvent.markets || []).length;
    
    // DEBUG: Log the raw markets
    if (DEBUG_H2H) {
      logger.debug('[scan] Raw PM markets', { count: pmRawCount, markets: pmEvent.markets?.map(m => ({ conditionId: m.conditionId?.slice(0, 12), group: m.groupItemTitle, q: m.question?.slice(0, 40) })) });
    }
    
    const pmMarketsRaw = chooseBestPmStructure(pmEvent.markets || [], kalshiMarkets, pmEvent.title);
    const pmFilteredCount = pmMarketsRaw.length;

    // A one-sided empty venue response is not evidence of a completed zero-arb
    // scan. Publishing it as `confirmed_zero` erased the prior canonical
    // Markets projection and added sparse `No arb` rows to Logs during ordinary
    // credential/feed degradation. Preserve the prior durable values and make
    // the failed replacement attempt explicit instead.
    if (kalshiMarkets.length === 0 || pmMarketsRaw.length === 0) {
      const platform = kalshiMarkets.length === 0 ? 'Kalshi' : 'Polymarket';
      const reasonCode = kalshiMarkets.length === 0
        ? 'kalshi_market_data_unavailable'
        : 'polymarket_market_data_unavailable';
      return failIncompleteScan(reasonCode, `${platform} returned no usable market data.`);
    }
    
    // DEBUG: Log the filtered markets
    if (DEBUG_H2H) {
      logger.debug('[scan] Filtered PM markets', { count: pmFilteredCount, markets: pmMarketsRaw.map(m => ({ conditionId: m.conditionId?.slice(0, 12), group: m.groupItemTitle, q: m.question?.slice(0, 40) })) });
    }
    
    // First match against Gamma prices, then fetch expensive CLOB metadata only
    // for actual cross-platform pairs. A large event can have 80+ PM outcomes
    // but fewer than 10 Kalshi counterparts; fetching every unrelated outcome
    // made the scan UI appear frozen for 40+ seconds.
    const preliminaryOutcomes = skipAutoMatch
      ? []
      : applyManualMatches(
          matchOutcomes(kalshiMarkets, pmMarketsRaw, pmEvent.title, capital, expiryDate ?? undefined),
          manualMatches,
          kalshiMarkets,
          pmMarketsRaw,
          capital,
          pmEvent.endDate,
        );
    const matchedKalshiTickers = [...new Set(preliminaryOutcomes.flatMap((outcome) =>
      outcome.kalshi?.ticker ? [outcome.kalshi.ticker] : []))];
    if (matchedKalshiTickers.length > 0) {
      await resolveKalshiFeeAuthoritiesForMarkets(kalshiMarkets, new Set(matchedKalshiTickers));
    }
    const conditionIds = selectMatchedClobConditionIds(preliminaryOutcomes);
    let clobMap: Map<string, any>;
    try {
      // Allow more time for large multi-outcome events (CLOB has 10-concurrent semaphore)
      const clobTimeout = Math.max(API_TIMEOUT_MS, conditionIds.length * 500);
      clobMap = await withTimeout(
        fetchClobMarkets(conditionIds),
        clobTimeout,
        'CLOB metadata',
      );
    } catch (e: any) {
      if (DEBUG_H2H) logger.debug('[scan] CLOB metadata unavailable', { error: e.message });
      return failIncompleteScan('clob_metadata_unavailable', `CLOB metadata request failed: ${e.message ?? 'unknown error'}.`);
    }

    // Build a case-insensitive CLOB map (conditionIds are lowercase hex, but normalize defensively)
    const clobMapLower = new Map<string, typeof clobMap extends Map<any, infer V> ? V : never>();
    for (const [key, val] of clobMap) {
      clobMapLower.set(key.toLowerCase(), val);
    }

    const selectedConditionIds = new Set(conditionIds.map(id => id.toLowerCase()));
    const missingConditionIds = [...selectedConditionIds].filter(id => !clobMapLower.has(id));
    if (missingConditionIds.length > 0) {
      return failIncompleteScan(
        'clob_metadata_incomplete',
        `CLOB metadata omitted ${missingConditionIds.length}/${selectedConditionIds.size} selected condition(s).`,
      );
    }

    // Enrich markets with CLOB prices in PARALLEL (was sequential — neg-risk
    // markets each make 2 HTTP calls, so 20 outcomes = 40 sequential requests).
    // getClobPrices already uses the internal CLOB semaphore for book fetches.
    const enrichmentResults = await Promise.all(
      pmMarketsRaw.map(async (m) => {
        const conditionId = typeof m.conditionId === 'string' ? m.conditionId.toLowerCase() : '';
        const clob = clobMapLower.get(conditionId) ?? clobMap.get(m.conditionId);
        if (!clob || !selectedConditionIds.has(conditionId)) return { market: m, failure: null };
        try {
          const [live, depth] = await Promise.all([getClobPrices(clob), getClobAskDepths(clob)]);
          if (!live) {
            return {
              market: m,
              failure: { reasonCode: 'clob_book_empty', detail: `CLOB returned no executable book for ${conditionId}.` },
            };
          }

          if (DEBUG_H2H) {
            logger.debug('[scan] CLOB neg_risk', { negRisk: clob.neg_risk, conditionId: m.conditionId?.slice(0, 12), question: m.question?.slice(0, 40) });
          }

          return { market: {
            ...m,
            outcomePrices: JSON.stringify([live.yesPrice.toFixed(6), live.noPrice.toFixed(6)]),
            bestBid: live.bestBid != null ? live.bestBid : m.bestBid,
            bestAsk: live.bestAsk != null ? live.bestAsk : m.bestAsk,
            lastTradePrice: live.lastTradePrice,
            // MF-001: only CLOB quantity at the displayed ask is executable.
            // Gamma liquidity is market-wide metadata, not an order-level guarantee.
            askDepth: depth.yesAskDepth,
            noAskDepth: depth.noAskDepth,
            yesBid: depth.yesBid,
            noBid: depth.noBid,
            yesBidDepth: depth.yesBidDepth,
            noBidDepth: depth.noBidDepth,
            quoteObservedAt: new Date().toISOString(),
            yesMinOrderSize: depth.yesMinOrderSize,
            noMinOrderSize: depth.noMinOrderSize,
            yesTickSize: depth.yesTickSize,
            noTickSize: depth.noTickSize,
            neg_risk: clob.neg_risk,
          }, failure: null };
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'unknown error';
          return {
            market: m,
            failure: { reasonCode: 'clob_book_unavailable', detail: `CLOB book request failed for ${conditionId}: ${detail}.` },
          };
        }
      }),
    );
    const enrichmentFailure = enrichmentResults.find(result => result.failure != null)?.failure;
    if (enrichmentFailure) {
      return failIncompleteScan(enrichmentFailure.reasonCode, enrichmentFailure.detail);
    }
    const pmMarkets: any[] = enrichmentResults.map(result => result.market);

    // Step 1: auto-match (skip if manual mode requested)
    const kalshiRawCount = kalshiMarkets.length;
    let outcomes;
    if (skipAutoMatch) {
      // Manual mode: don't auto-match anything — all markets are unmatched
      outcomes = [
        ...kalshiMarkets.map(km => ({
          artist: km.yes_sub_title || km.title || km.ticker,
          // Keep the manual-match response on the same finite-price boundary
          // as matched outcomes. Raw parseFloat() here previously reintroduced
          // NaN/Infinity despite buildKalshiArbShape() failing those quotes closed.
          kalshi: buildKalshiArbShape(km),
          polymarket: null,
          arbitrage: { roiPct: 0, expectedProfit: 0, strategy: 'No arb', kalshiStake: 0, pmStake: 0, fees: null, apyPct: 0 },
          platformA: 'kalshi' as const,
          platformB: null,
        })),
        ...pmMarkets.map(pm => {
          const [yesPrice, noPrice] = parseOutcomePrices(pm.outcomePrices);
          return {
            artist: pm.groupItemTitle || pm.question || 'Unknown',
            kalshi: null,
            polymarket: {
              conditionId: pm.conditionId,
              marketId: pm.id,
              yesPrice,
              noPrice,
              bestBid: pm.bestBid ?? 0,
              bestAsk: pm.bestAsk ?? 0,
              lastTradePrice: pm.lastTradePrice ?? 0,
            },
            arbitrage: { roiPct: 0, expectedProfit: 0, strategy: 'No arb', kalshiStake: 0, pmStake: 0, fees: null, apyPct: 0 },
            platformA: null,
            platformB: 'polymarket' as const,
          };
        }),
      ];
    } else {
      const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent.title, capital, expiryDate ?? undefined);
      // Step 2: apply manual matches to merge auto-unmatched pairs
      outcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, capital, expiryDate ?? undefined);
    }

    // Step 2b: split decoupled pairs — user has explicitly unlinked these
    const splitOutcomes = applyDecoupledPairs(outcomes as unknown as UnifiedOutcome[], decoupledPairs);

    // Step 3: compute arbitrage (with depth awareness) for all matched items, including cross-outcome
    // SET-003: hot-apply the configurable suspicious-ROI threshold
    const suspRoi = await getSetting<number>('scanner.suspiciousRoiPct').catch(() => null);
    if (suspRoi != null) setSuspiciousRoiPct(suspRoi);

    const scanObservedAt = new Date().toISOString();
    const withArbitrage = attachOutcomeContingentApy(
      calculateAllArbitrages(splitOutcomes, pmEvent.title, capital),
      scanObservedAt,
      expiryDate,
    );

    // BUG-05b2: Smart expiry — compute priceResolved once, reuse for DB save + response.
    // In-play markets (trading at 68/32 etc) are NOT expired even if closeTime passed.
    const priceResolved = computePriceResolved(withArbitrage.map(o => ({
      kalshi: o.kalshi ? { yesAsk: o.kalshi.yesAsk, noAsk: o.kalshi.noAsk } : null,
      polymarket: o.polymarket ? { yesPrice: o.polymarket.yesPrice, noPrice: o.polymarket.noPrice } : null,
    })));

    // Smart expiry check: only expired when closeTime passed AND prices at resolution
    // (or PM explicitly closed). In-play markets proceed normally.
    const pmClosed = Boolean(pmEvent.closed) && !pmEvent.active;
    let expired = false;
    if (expiryDate && !force) {
      const expiryMs = new Date(expiryDate).getTime();
      if (expiryMs > 0 && expiryMs <= Date.now()) {
        expired = priceResolved || pmClosed;
      }
    }

    const kalshiCount = withArbitrage.filter(o => o.kalshi).length;
    const pmCount = withArbitrage.filter(o => o.polymarket).length;
    const matchedCount = withArbitrage.filter(o => o.kalshi && o.polymarket).length;
    const matchedPairs = withArbitrage
      .filter(o => o.kalshi && o.polymarket)
      .map(o => ({ artist: o.artist, kalshiTicker: o.kalshi!.ticker, pmConditionId: o.polymarket!.conditionId }));

    // Unmatched for the manual-matching UI
    const unmatchedKalshi = withArbitrage
      .filter(o => o.kalshi && !o.polymarket)
      .map(o => ({
        ticker: o.kalshi!.ticker,
        title: o.artist,
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

    // ---- UPDATE SAVED MARKET SCAN RESULT ----
    try {
      // PERF-P1: targeted single-market lookup instead of loading all markets
      const market = savedMarket;
      if (market) {
        // Sanity guard: exclude suspicious phantoms (huge ROI + unknown depth).
        // They stay visible in the scan payload itself (flagged) so the UI can
        // grey them out, but they must not drive history, lifecycle, or alerts.
        const suspiciousCount = withArbitrage.filter(o => o.arbitrage?.suspicious).length;
        if (suspiciousCount > 0) {
          console.log(`[scan] ${market.eventTitle}: ${suspiciousCount} suspicious arb(s) excluded from stats (ROI > threshold with unknown depth)`);
        }
        // Economic positive candidates: the canonical "Positive Arb" set that
        // /logs counts and BotTrader evaluates. They must have valid
        // classification, positive ROI/profit, and positive stake regardless of
        // current executability. Separating this from executable-only filtering
        // is what lets non_executable candidates (e.g., Polymarket min order
        // size > 1 share) appear in logs and be evaluated by BotTrader while
        // still failing alerts/execution until they become executable.
        const positiveArbs = withArbitrage.filter(o => o.arbitrage
          && auditArbClassification(o.arbitrage.strategy, o.arbitrage.arbType).valid
          && o.arbitrage.arbType !== null
          && o.arbitrage.roiPct > 0
          && o.arbitrage.expectedProfit > 0
          && (o.arbitrage.kalshiStake + o.arbitrage.pmStake) > 0
          && !o.arbitrage.suspicious);
        // Lifecycle and Telegram alerts only fire for currently executable
        // positive arbs to avoid noise on size-limited or otherwise
        // non-tradeable opportunities.
        const executablePositiveArbs = positiveArbs.filter(o =>
          o.arbitrage!.executionStatus === 'executable');
        // UI-03: Track best net arb (positive OR negative) for display.
        // netArbs includes the best candidate even when negative, so the UI
        // shows how close a pair is to profitability.
        const netArbs = withArbitrage.filter(o => o.arbitrage
          && auditArbClassification(o.arbitrage.strategy, o.arbitrage.arbType).valid
          && o.arbitrage.arbType !== null
          && o.arbitrage.strategy !== 'No arb' && !o.arbitrage.suspicious);
        const hasUnavailablePositiveCandidate = netArbs.some(o => o.arbitrage!.roiPct > 0
          && (o.arbitrage?.executionStatus == null || o.arbitrage.executionStatus === 'unavailable'));
        if (executablePositiveArbs.length === 0 && hasUnavailablePositiveCandidate) {
          return failIncompleteScan(
            'executable_candidate_unavailable',
            `All ${netArbs.length} selected candidate(s) lacked complete executable price evidence.`,
            { retainedCanonical: positiveArbs.length > 0 },
          );
        }
        const bestNetArb = positiveArbs.length > 0
          ? positiveArbs.reduce((best, o) => o.arbitrage!.roiPct > best.arbitrage!.roiPct ? o : best)
          : null;
        const scanResult = {
          bestRoiPct: bestNetArb ? bestNetArb.arbitrage!.roiPct : 0,
          bestProfit: bestNetArb ? bestNetArb.arbitrage!.expectedProfit : 0,
          strategy: bestNetArb ? bestNetArb.arbitrage!.strategy : 'No arb',
          calculationEnvelope: bestNetArb?.arbitrage?.calculationEnvelope,
          arbType: bestNetArb ? (bestNetArb.arbitrage as any).arbType ?? null : null,
          outcomeCount: withArbitrage.length,
          matchedCount,
          matchStatus: positiveArbs.length > 0 ? 'matched' as const : 'confirmed_zero' as const,
          matchedPairs,
          kalshiCount,
          pmCount,
          scannedAt: scanObservedAt,
          publicationGeneration: publicationGeneration ?? undefined,
          category: scanCategory,
          // UI-013: PM often keeps endDate far in the future even after a market
          // resolves. Persist PM's own closed signal so the UI can treat
          // closed-but-not-yet-past-endDate markets as expired.
          pmClosed,
          priceResolved,
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
            kalshiYesDepth: o.kalshi?.yesAskDepth,
            kalshiNoDepth: o.kalshi?.noAskDepth,
            pmConditionId: selectedPmConditionId,
            pmYesTokenId: selectedPmLeg?.yesTokenId,
            pmNoTokenId: selectedPmLeg?.noTokenId,
            kalshiYesExecutableQuote: quoteOneShareFromTopAsk({
              price: o.kalshi?.yesAsk, depthUsd: o.kalshi?.yesAskDepth,
              tickSize: o.kalshi?.yesTickSize, minimumOrderSize: 1, depthTimestamp: scanObservedAt,
              unavailableReason: kalshiDepthUnavailableReason(o.kalshi?.yesAskDepthStatus),
            }),
            kalshiNoExecutableQuote: quoteOneShareFromTopAsk({
              price: o.kalshi?.noAsk, depthUsd: o.kalshi?.noAskDepth,
              tickSize: o.kalshi?.noTickSize, minimumOrderSize: 1, depthTimestamp: scanObservedAt,
              unavailableReason: kalshiDepthUnavailableReason(o.kalshi?.noAskDepthStatus),
            }),
            pmYesExecutableQuote: quoteOneShareFromTopAsk({
              price: selectedPmLeg?.yesPrice, depthUsd: selectedPmLeg?.askDepth,
              tickSize: selectedPmLeg?.yesTickSize, minimumOrderSize: selectedPmLeg?.yesMinOrderSize,
              depthTimestamp: scanObservedAt,
            }),
            pmNoExecutableQuote: quoteOneShareFromTopAsk({
              price: selectedPmLeg?.noPrice, depthUsd: selectedPmLeg?.noAskDepth,
              tickSize: selectedPmLeg?.noTickSize, minimumOrderSize: selectedPmLeg?.noMinOrderSize,
              depthTimestamp: scanObservedAt,
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
            evaluationContracts: o.arbitrage!.evaluationContracts ?? o.arbitrage!.requestedContracts ?? 1,
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
            fees: o.arbitrage!.fees,
            calculationEnvelope: o.arbitrage!.calculationEnvelope,
          };
          }),
        };
        const published = await withSqliteBusyRetry(() => updateSavedMarketScanResult(
          market.id,
          scanResult,
          expiryResolution?.expiryAt,
          expiryResolution ? {
            source: expiryResolution.source,
            sourceId: expiryResolution.sourceId,
            observedAt: scanObservedAt,
          } : undefined,
        ));
        if (!published) throw new Error('Saved-market publication was superseded before persistence');
        fullScanPersisted = true;
        try {
          await withSqliteBusyRetry(() => persistPlatformPriceSnapshots(snapshotInputsFromOutcomes(
            withArbitrage,
            { kalshi: scanObservedAt, polymarket: scanObservedAt },
            'saved-market-full-scan',
            {
              attemptedAt: scanAttemptedAt,
              generation: publicationGeneration ?? 0,
              scope: savedMarketId,
            },
          )));
        } catch (snapshotErr) {
          console.warn('[current-price-snapshots] persistence failed (scan result remains durable):', snapshotErr instanceof Error ? snapshotErr.message : snapshotErr);
        }
        try {
          await withSqliteBusyRetry(() => appendScanHistory({
            scanTimestamp: new Date().toISOString(),
            marketId: market.id,
            totalProfit: positiveArbs.reduce((s, a) => s + a.arbitrage!.expectedProfit, 0),
            bestRoiPct: bestNetArb ? bestNetArb.arbitrage!.roiPct : 0,
            positiveArbCount: positiveArbs.length,
            matchedCount,
          }));
        } catch (historyErr) {
          console.warn('[scan-history] persistence failed (scan result remains durable):', historyErr instanceof Error ? historyErr.message : historyErr);
        }

        // Bot consumption is secondary to publishing the saved-market result.
        // Do not turn a durable full scan into an HTTP 500 if strategy
        // evaluation encounters independent contention.
        try {
          await withSqliteBusyRetry(() => persistAndConsumeBotScan(market.id, {
          bestRoiPct: scanResult.bestRoiPct,
          bestProfit: scanResult.bestProfit,
          strategy: scanResult.strategy,
          outcomeCount: scanResult.outcomeCount,
          matchedCount: scanResult.matchedCount,
          kalshiCount: scanResult.kalshiCount,
          pmCount: scanResult.pmCount,
          positiveArbCount: positiveArbs.length,
          totalStake: scanResult.allArbs?.reduce((s, a) => s + (a.totalStake ?? 0), 0) ?? 0,
          scannedAt: scanResult.scannedAt,
          expiryAt: expiryDate,
          outcomeApy: bestNetArb?.arbitrage?.outcomeApy,
          calculationEnvelope: scanResult.calculationEnvelope,
          // ARB-01a: persist the best arb's type classification
          arbType: bestNetArb?.arbitrage?.arbType ?? undefined,
          // PERF-P2: raw blob only stored when there are arbs to drill into —
          // zero-arb scans (vast majority) get NULL, keeping the DB lean.
          raw: (scanResult.allArbs?.length ?? 0) > 0
            ? { allArbs: scanResult.allArbs, scanCapital: capital, outcomeApy: bestNetArb?.arbitrage?.outcomeApy, category: scanCategory }
            : undefined,
          marketTitle: pmEvent.title || market.eventTitle,
          kalshiUrl,
          polymarketUrl,
          }, 'scan_api'));
        } catch (botErr) {
          console.warn('[bot-scan-consumer] persistence failed (scan unaffected):', botErr instanceof Error ? botErr.message : botErr);
        }

        // ── Arb lifecycle tracking: open/extend/close episodes ──
        // Non-fatal: lifecycle data must never break a scan. Only executable
        // positive arbs should open/extend/close episodes.
        try {
          const lifecycle = await recordArbObservations(
            market.id,
            pmEvent.title || market.eventTitle,
            (market as { category?: string }).category,
            executablePositiveArbs.map(o => ({
              outcome: o.artist,
              strategy: o.arbitrage!.strategy,
              roiPct: o.arbitrage!.roiPct,
              expectedProfit: o.arbitrage!.expectedProfit,
              totalStake: (o.arbitrage!.kalshiStake ?? 0) + (o.arbitrage!.pmStake ?? 0),
            })),
          );
          if (lifecycle.opened > 0 || lifecycle.closed > 0) {
            console.log(`[arb-lifecycle] ${market.eventTitle}: ${lifecycle.opened} opened, ${lifecycle.extended} extended, ${lifecycle.closed} closed`);
          }
        } catch (lcErr) {
          console.warn('[arb-lifecycle] tracking failed (scan unaffected):', lcErr instanceof Error ? lcErr.message : lcErr);
        }

        // ── Telegram alerts: fire if executable positive arbs found ──
        if (executablePositiveArbs.length > 0) {
          const alertArbs: ArbAlertInput[] = executablePositiveArbs.map(o => ({
            marketTitle: pmEvent.title,
            marketId: market.id,
            outcome: o.artist,
            roiPct: o.arbitrage!.roiPct,
            apyPct: o.arbitrage!.apyPct,
            daysToExpiry: o.arbitrage!.daysToExpiry,
            apyUnavailableReason: o.arbitrage!.apyUnavailableReason,
            expectedProfit: o.arbitrage!.expectedProfit,
            strategy: o.arbitrage!.strategy,
            arbType: (o.arbitrage as any).arbType,
            totalStake: (o.arbitrage!.kalshiStake ?? 0) + (o.arbitrage!.pmStake ?? 0),
            fees: o.arbitrage!.fees,
            calculationEnvelope: o.arbitrage!.calculationEnvelope,
          }));
          // Fire-and-forget — don't block scan response on Telegram
          sendBatchAlerts(alertArbs).catch(err => {
            logger.trackError(err, { service: 'telegram-alerts', context: 'scan batch' });
          });
        }
      }
    } catch (e) {
      logger.trackError(e, { service: 'scan', path: '/api/scan' });
      if (savedMarketId && publicationGeneration != null) {
        const matchError = clientSafeError(e, 'Scan result persistence failed', { path: '/api/scan' });
        await reconcileSavedMarketMatchSummary(savedMarketId, {
          matchedCount: 0,
          matchStatus: 'unavailable',
          matchError,
          matchedPairs: undefined,
          scannedAt: new Date().toISOString(),
          publicationGeneration,
        }).catch(() => {});
      }
    }

    return NextResponse.json({
      eventTitle: pmEvent.title,
      category: scanCategory,
      kalshiEventTicker: kalshiTicker,
      pmEventSlug: pmSlug,
      pmEventId: pmEvent.id,
      expiryDate,
      expirySource: expiryResolution?.source ?? savedMarket?.expirySource ?? null,
      expirySourceId: expiryResolution?.sourceId ?? savedMarket?.expirySourceId ?? null,
      kalshiCount,
      pmCount,
      matchedCount,
      kalshiRawCount,
      pmRawCount,
      pmFilteredCount,
      kalshiFetchSource,
      kalshiSeriesFetched: kalshiSeriesFetched.length > 0 ? kalshiSeriesFetched : undefined,
      clobHitCount: clobMap.size,
      clobMissCount: conditionIds.length - clobMap.size,
      outcomes: withArbitrage,
      unmatchedKalshi,
      unmatchedPolymarket,
      expired,
      priceResolved,
      _ts: Date.now(),
      _kalshiFetchedAt: new Date().toISOString(),
      _pmFetchedAt: new Date().toISOString(),
      fullScanPersisted,
      publicationGeneration: fullScanPersisted ? publicationGeneration : null,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      }
    });
  } catch (err: any) {
    logger.trackError(err, { service: 'scan', path: '/api/scan' });
    const msg = clientSafeError(err, 'Unknown error');
    const status = msg.includes('timed out') ? 504 : msg.includes('not found') ? 404 : 500;
    if (savedMarketId && publicationGeneration != null) {
      await reconcileSavedMarketMatchSummary(savedMarketId, {
        matchedCount: 0,
        matchStatus: 'unavailable',
        matchError: msg,
        matchedPairs: undefined,
        scannedAt: new Date().toISOString(),
        publicationGeneration,
      }).catch(() => {});
    }
    return NextResponse.json(
      { error: msg },
      { status }
    );
  } finally {
    if (scanLock) await releaseSavedMarketScanLock(scanLock).catch(() => {});
  }
}
