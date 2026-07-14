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
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl } from '@/lib/polymarket';
import { fetchClobMarkets, getClobPrices } from '@/lib/polymarket-clob';
import { matchOutcomes, calculateAllArbitrages, parseDepth, computeApy, applyManualMatches, setSuspiciousRoiPct, UnifiedOutcome } from '@/lib/matcher';
import { getSetting } from '@/lib/settings';
import { getManualMatches } from '@/lib/manual-matches';
import { getDecoupledPairs, applyDecoupledPairs } from '@/lib/decoupled-pairs';
import { getSavedMarkets, findSavedMarketByUrls, updateSavedMarketScanResult, appendScanHistory, saveScanResult } from '@/lib/persistence';
import { recordArbObservations } from '@/lib/arb-lifecycle';
import { sendBatchAlerts, ArbAlertInput } from '@/lib/telegram-alerts';
import { clientSafeError } from '@/lib/error-handler';
import { withTimeout, chooseBestPmStructure } from '@/lib/scan-shared';
import { computePriceResolved } from '@/app/lib/page-shared';

const API_TIMEOUT_MS = 15000; // 15s timeout for upstream APIs
const DEBUG_H2H = process.env.DEBUG_H2H === '1' || process.env.DEBUG_H2H === 'true';

export async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { kalshiUrl, polymarketUrl, skipAutoMatch, capital = 1000, force = false } = body;

    const kalshiTicker = kalshiUrl ? extractKalshiEventTicker(kalshiUrl) : null;
    const pmSlug = polymarketUrl ? extractPolymarketSlug(polymarketUrl) : null;

    if (!kalshiTicker) {
      return NextResponse.json(
        { error: 'Invalid Kalshi URL. Expected format: https://kalshi.com/markets/{series}/.../{ticker}' },
        { status: 400 }
      );
    }
    if (!pmSlug) {
      return NextResponse.json(
        { error: 'Invalid Polymarket URL. Expected format: https://polymarket.com/event/{slug} or /sports/{path}' },
        { status: 400 }
      );
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
                  API_TIMEOUT_MS * 2, 'Kalshi multi-series',
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
        isPolymarketMarketUrl(polymarketUrl)
          ? fetchPolymarketMarketAsEvent(pmSlug)
          : fetchPolymarketEvent(pmSlug),
        API_TIMEOUT_MS, 'Polymarket event',
      ),
      getManualMatches(),
      getDecoupledPairs(),
    ]);

    // Filter Kalshi markets to the specific match within a multi-game event
    kalshiMarkets = filterKalshiMarketsToMatch(kalshiMarkets, extractKalshiMatchKey(kalshiUrl));

    if (!pmEvent) {
      return NextResponse.json(
        { error: 'Polymarket event not found. The market may have closed or the URL may be incorrect.' },
        { status: 404 }
      );
    }

    const expiryDate = pmEvent.endDate;

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
    
    const conditionIds = pmMarketsRaw.map(m => m.conditionId).filter(Boolean) as string[];
    let clobMap: Map<string, any>;
    try {
      // Allow more time for large multi-outcome events (CLOB has 10-concurrent semaphore)
      const clobTimeout = Math.max(API_TIMEOUT_MS, conditionIds.length * 2000);
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
          const live = await getClobPrices(clob);
          if (!live) return m;

          if (DEBUG_H2H) {
            logger.debug('[scan] CLOB neg_risk', { negRisk: clob.neg_risk, conditionId: m.conditionId?.slice(0, 12), question: m.question?.slice(0, 40) });
          }

          return {
            ...m,
            outcomePrices: JSON.stringify([live.yesPrice.toFixed(6), live.noPrice.toFixed(6)]),
            bestBid: live.bestBid != null ? live.bestBid : m.bestBid,
            bestAsk: live.bestAsk != null ? live.bestAsk : m.bestAsk,
            lastTradePrice: live.lastTradePrice,
            noAskDepth: Number(m.liquidityNum ?? m.liquidity ?? 0),
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
          kalshi: {
            ticker: km.ticker,
            yesBid: parseFloat(km.yes_bid_dollars || '0'),
            yesAsk: parseFloat(km.yes_ask_dollars || '1'),
            noBid: parseFloat(km.no_bid_dollars || '0'),
            noAsk: parseFloat(km.no_ask_dollars || '1'),
            lastPrice: parseFloat(km.last_price_dollars || '0'),
            yesAskDepth: km.yes_ask_size_fp,
            noAskDepth: km.no_ask_size_fp,
          },
          polymarket: null,
          arbitrage: { roiPct: 0, expectedProfit: 0, strategy: 'No arb', kalshiStake: 0, pmStake: 0, fees: null, apyPct: 0 },
          platformA: 'kalshi' as const,
          platformB: null,
        })),
        ...pmMarkets.map(pm => ({
          artist: pm.groupItemTitle || pm.question || 'Unknown',
          kalshi: null,
          polymarket: {
            conditionId: pm.conditionId,
            marketId: pm.id,
            yesPrice: parseFloat(JSON.parse(pm.outcomePrices || '["0","1"]')[0] || '0'),
            noPrice: parseFloat(JSON.parse(pm.outcomePrices || '["0","1"]')[1] || '1'),
            bestBid: pm.bestBid ?? 0,
            bestAsk: pm.bestAsk ?? 0,
            lastTradePrice: pm.lastTradePrice ?? 0,
          },
          arbitrage: { roiPct: 0, expectedProfit: 0, strategy: 'No arb', kalshiStake: 0, pmStake: 0, fees: null, apyPct: 0 },
          platformA: null,
          platformB: 'polymarket' as const,
        })),
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

    const withArbitrage = calculateAllArbitrages(splitOutcomes, pmEvent.title, capital).map(o => ({
      ...o,
      arbitrage: {
        ...o.arbitrage,
        apyPct: computeApy(o.arbitrage.roiPct, pmEvent.endDate),
      },
    }));

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
      const market = await findSavedMarketByUrls(kalshiUrl, polymarketUrl);
      if (market) {
        // Sanity guard: exclude suspicious phantoms (huge ROI + unknown depth)
        // from stats, history, lifecycle, and alerts. They stay visible in the
        // scan payload itself (flagged) so the UI can grey them out.
        const positiveArbs = withArbitrage.filter(o => o.arbitrage && o.arbitrage.roiPct > 0 && !o.arbitrage.suspicious);
        const suspiciousCount = withArbitrage.filter(o => o.arbitrage?.suspicious).length;
        if (suspiciousCount > 0) {
          console.log(`[scan] ${market.eventTitle}: ${suspiciousCount} suspicious arb(s) excluded from stats (ROI > threshold with unknown depth)`);
        }
        // UI-03: Track best net arb (positive OR negative) for display.
        // positiveArbs still used for alerts/lifecycle — we don't want to trigger
        // alerts on negative arbs. netArbs includes the best candidate even when
        // negative, so the UI shows how close a pair is to profitability.
        const netArbs = withArbitrage.filter(o => o.arbitrage && o.arbitrage.strategy !== 'No arb' && !o.arbitrage.suspicious);
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
          kalshiCount,
          pmCount,
          scannedAt: new Date().toISOString(),
          // UI-013: PM often keeps endDate far in the future even after a market
          // resolves. Persist PM's own closed signal so the UI can treat
          // closed-but-not-yet-past-endDate markets as expired.
          pmClosed,
          priceResolved,
          allArbs: netArbs.map(o => ({
            artist: o.artist,
            roiPct: o.arbitrage!.roiPct,
            expectedProfit: o.arbitrage!.expectedProfit,
            strategy: o.arbitrage!.strategy,
            arbType: o.arbitrage!.arbType,
            totalStake: (o.arbitrage!.kalshiStake ?? 0) + (o.arbitrage!.pmStake ?? 0),
            fees: o.arbitrage!.fees,
          })),
        };
        await updateSavedMarketScanResult(market.id, scanResult, pmEvent.endDate);
        // Record in global scan history (JSON)
        await appendScanHistory({
          scanTimestamp: new Date().toISOString(),
          marketId: market.id,
          totalProfit: positiveArbs.reduce((s, a) => s + a.arbitrage!.expectedProfit, 0),
          bestRoiPct: bestArb ? bestArb.arbitrage!.roiPct : 0,
          positiveArbCount: positiveArbs.length,
          matchedCount,
        });
        // Also persist to SQLite for Dashboard & Logs
        await saveScanResult(market.id, {
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
          // ARB-01a: persist the best arb's type classification
          arbType: bestNetArb?.arbitrage?.arbType ?? undefined,
          // PERF-P2: raw blob only stored when there are arbs to drill into —
          // zero-arb scans (vast majority) get NULL, keeping the DB lean.
          raw: (scanResult.allArbs?.length ?? 0) > 0 ? { allArbs: scanResult.allArbs } : undefined,
          marketTitle: pmEvent.title || market.eventTitle,
          kalshiUrl,
          polymarketUrl,
        });

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
    }

    return NextResponse.json({
      eventTitle: pmEvent.title,
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
    return NextResponse.json(
      { error: msg },
      { status }
    );
  }
}
