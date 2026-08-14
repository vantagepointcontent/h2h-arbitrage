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
import { buildKalshiArbShape, matchOutcomes, calculateAllArbitrages, parseDepth, attachOutcomeContingentApy, applyManualMatches, setSuspiciousRoiPct, UnifiedOutcome } from '@/lib/matcher';
import { getSetting } from '@/lib/settings';
import { getManualMatches } from '@/lib/manual-matches';
import { getDecoupledPairs, applyDecoupledPairs } from '@/lib/decoupled-pairs';
import { findSavedMarketByUrls, reconcileSavedMarketMatchSummary, reserveSavedMarketPublication, updateSavedMarketScanResult, appendScanHistory } from '@/lib/persistence';
import { persistAndConsumeBotScan } from '@/lib/bot-scan-consumer';
import { recordArbObservations } from '@/lib/arb-lifecycle';
import { sendBatchAlerts, ArbAlertInput } from '@/lib/telegram-alerts';
import { clientSafeError } from '@/lib/error-handler';
import { withTimeout, chooseBestPmStructure } from '@/lib/scan-shared';
import { computePriceResolved } from '@/app/lib/page-shared';
import { auditArbClassification } from '@/lib/arb-types';
import { getUnavailableScanPlatforms, resolveScanLinks } from '@/lib/scan-links';
import { parseScanCapital } from '@/lib/scan-request';
import { parseJsonObject } from '@/lib/request-json';
import { resolveMarketDomain } from '@/lib/market-classification';
import { selectMatchedClobConditionIds } from '@/lib/scan-clob-selection';
import { withSqliteBusyRetry } from '@/lib/sqlite-write-retry';
import { persistPlatformPriceSnapshots, snapshotInputsFromOutcomes } from '@/lib/current-price-snapshots';
import {
  acquireSavedMarketScanLock,
  releaseSavedMarketScanLock,
  type SavedMarketScanLock,
} from '@/lib/saved-market-scan-lock';

const API_TIMEOUT_MS = 5000; // OPS-011: 5s timeout — was 15s, caused 17-29s total scan times
const KALSHI_MULTI_TIMEOUT_MS = 8000; // multi-series gets a bit more headroom
const DEBUG_H2H = process.env.DEBUG_H2H === '1' || process.env.DEBUG_H2H === 'true';

export async function executeFullScan(request: NextRequest) {
  let savedMarketId: string | null = null;
  let publicationGeneration: number | null = null;
  let fullScanPersisted = false;
  let scanLock: SavedMarketScanLock | null = null;
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

    const expiryDate = pmEvent.endDate;

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
          matchOutcomes(kalshiMarkets, pmMarketsRaw, pmEvent.title, capital, pmEvent.endDate),
          manualMatches,
          kalshiMarkets,
          pmMarketsRaw,
          capital,
          pmEvent.endDate,
        );
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
      if (DEBUG_H2H) logger.debug('[scan] CLOB metadata unavailable, falling back to gamma prices', { error: e.message });
      clobMap = new Map();
    }

    // Build a case-insensitive CLOB map (conditionIds are lowercase hex, but normalize defensively)
    const clobMapLower = new Map<string, typeof clobMap extends Map<any, infer V> ? V : never>();
    for (const [key, val] of clobMap) {
      clobMapLower.set(key.toLowerCase(), val);
    }

    // Enrich markets with CLOB prices in PARALLEL (was sequential — neg-risk
    // markets each make 2 HTTP calls, so 20 outcomes = 40 sequential requests).
    // getClobPrices already uses the internal CLOB semaphore for book fetches.
    const pmMarkets: any[] = await Promise.all(
      pmMarketsRaw.map(async (m) => {
        const clob = clobMapLower.get(m.conditionId?.toLowerCase()) ?? clobMap.get(m.conditionId);
        if (!clob) return m;
        try {
          const [live, depth] = await Promise.all([getClobPrices(clob), getClobAskDepths(clob)]);
          if (!live) {
            // The CLOB was reachable but has no executable asks. Keep its token
            // prices for display (the same values shown by Polymarket), but mark
            // them non-executable so they cannot create an arbitrage signal.
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

          if (DEBUG_H2H) {
            logger.debug('[scan] CLOB neg_risk', { negRisk: clob.neg_risk, conditionId: m.conditionId?.slice(0, 12), question: m.question?.slice(0, 40) });
          }

          return {
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
          };
        } catch {
          return m;
        }
      }),
    );

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
      const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent.title, capital, pmEvent.endDate);
      // Step 2: apply manual matches to merge auto-unmatched pairs
      outcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, capital, pmEvent.endDate);
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
        // Sanity guard: exclude suspicious phantoms (huge ROI + unknown depth)
        // from stats, history, lifecycle, and alerts. They stay visible in the
        // scan payload itself (flagged) so the UI can grey them out.
        const positiveArbs = withArbitrage.filter(o => o.arbitrage
          && auditArbClassification(o.arbitrage.strategy, o.arbitrage.arbType).valid
          && o.arbitrage.arbType !== null
          && o.arbitrage.roiPct > 0 && !o.arbitrage.suspicious);
        const suspiciousCount = withArbitrage.filter(o => o.arbitrage?.suspicious).length;
        if (suspiciousCount > 0) {
          console.log(`[scan] ${market.eventTitle}: ${suspiciousCount} suspicious arb(s) excluded from stats (ROI > threshold with unknown depth)`);
        }
        // UI-03: Track best net arb (positive OR negative) for display.
        // positiveArbs still used for alerts/lifecycle — we don't want to trigger
        // alerts on negative arbs. netArbs includes the best candidate even when
        // negative, so the UI shows how close a pair is to profitability.
        const netArbs = withArbitrage.filter(o => o.arbitrage
          && auditArbClassification(o.arbitrage.strategy, o.arbitrage.arbType).valid
          && o.arbitrage.arbType !== null
          && o.arbitrage.strategy !== 'No arb' && !o.arbitrage.suspicious);
        const bestNetArb = netArbs.length > 0
          ? netArbs.reduce((best, o) => o.arbitrage!.roiPct > best.arbitrage!.roiPct ? o : best)
          : null;
        const bestArb = positiveArbs.length > 0
          ? positiveArbs.reduce((best, o) => o.arbitrage!.roiPct > best.arbitrage!.roiPct ? o : best)
          : null;
        const scanResult = {
          bestRoiPct: bestNetArb ? bestNetArb.arbitrage!.roiPct : 0,
          bestProfit: bestNetArb ? bestNetArb.arbitrage!.expectedProfit : 0,
          strategy: bestNetArb ? bestNetArb.arbitrage!.strategy : 'No arb',
          arbType: bestNetArb ? (bestNetArb.arbitrage as any).arbType ?? null : null,
          outcomeCount: withArbitrage.length,
          matchedCount,
          matchStatus: matchedCount > 0 ? 'matched' as const : 'confirmed_zero' as const,
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
            roiPct: o.arbitrage!.roiPct,
            expectedProfit: o.arbitrage!.expectedProfit,
            strategy: o.arbitrage!.strategy,
            arbType: o.arbitrage!.arbType ?? undefined,
            totalStake: (o.arbitrage!.kalshiStake ?? 0) + (o.arbitrage!.pmStake ?? 0),
            kalshiTicker: o.kalshi?.ticker,
            kalshiYesAsk: o.kalshi?.yesAsk,
            kalshiNoAsk: o.kalshi?.noAsk,
            kalshiYesBid: o.kalshi?.yesBid,
            kalshiNoBid: o.kalshi?.noBid,
            kalshiYesDepth: o.kalshi?.yesAskDepth,
            kalshiNoDepth: o.kalshi?.noAskDepth,
            pmConditionId: selectedPmConditionId,
            pmYesPrice: selectedPmLeg?.yesPrice,
            pmNoPrice: selectedPmLeg?.noPrice,
            pmBestBid: selectedPmLeg?.bestBid,
            pmBestAsk: selectedPmLeg?.bestAsk,
            pmYesDepth: selectedPmLeg?.askDepth,
            pmNoDepth: selectedPmLeg?.noAskDepth,
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
            outcomeApy: o.arbitrage!.outcomeApy,
            buyPlatform: o.arbitrage!.buyPlatform,
            buyPrice: o.arbitrage!.buyPrice,
            sellPlatform: o.arbitrage!.sellPlatform,
            sellPrice: o.arbitrage!.sellPrice,
            fees: o.arbitrage!.fees,
          };
          }),
        };
        const published = await withSqliteBusyRetry(() => updateSavedMarketScanResult(market.id, scanResult, pmEvent.endDate));
        if (!published) throw new Error('Saved-market publication was superseded before persistence');
        fullScanPersisted = true;
        try {
          await withSqliteBusyRetry(() => persistPlatformPriceSnapshots(snapshotInputsFromOutcomes(
            withArbitrage,
            { kalshi: scanObservedAt, polymarket: scanObservedAt },
            'saved-market-full-scan',
          )));
        } catch (snapshotErr) {
          console.warn('[current-price-snapshots] persistence failed (scan result remains durable):', snapshotErr instanceof Error ? snapshotErr.message : snapshotErr);
        }
        try {
          await withSqliteBusyRetry(() => appendScanHistory({
            scanTimestamp: new Date().toISOString(),
            marketId: market.id,
            totalProfit: positiveArbs.reduce((s, a) => s + a.arbitrage!.expectedProfit, 0),
            bestRoiPct: bestArb ? bestArb.arbitrage!.roiPct : 0,
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
          expiryAt: bestNetArb?.arbitrage?.outcomeApy?.apyPct != null
            ? bestNetArb.arbitrage.outcomeApy.scenarioA.settlementAt
            : null,
          outcomeApy: bestNetArb?.arbitrage?.outcomeApy,
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
        // Non-fatal: lifecycle data must never break a scan.
        try {
          const lifecycle = await recordArbObservations(
            market.id,
            pmEvent.title || market.eventTitle,
            (market as { category?: string }).category,
            positiveArbs.map(o => ({
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

        // ── Telegram alerts: fire if positive arbs found ──
        if (positiveArbs.length > 0) {
          const alertArbs: ArbAlertInput[] = positiveArbs.map(o => ({
            marketTitle: pmEvent.title,
            marketId: market.id,
            outcome: o.artist,
            roiPct: o.arbitrage!.roiPct,
            expectedProfit: o.arbitrage!.expectedProfit,
            strategy: o.arbitrage!.strategy,
            arbType: (o.arbitrage as any).arbType,
            totalStake: (o.arbitrage!.kalshiStake ?? 0) + (o.arbitrage!.pmStake ?? 0),
            fees: o.arbitrage!.fees,
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
      expiryDate: pmEvent.endDate,
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
