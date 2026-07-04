import { NextRequest, NextResponse } from 'next/server';
import logger from '@/lib/logger';
import {
  extractKalshiEventTicker,
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
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

    // Kalshi: try event_ticker first, fallback to series_ticker
    let kalshiFetchSource: 'event_ticker' | 'series_prefix' | 'series_ticker' | 'none' = 'none';
    const [kalshiMarkets, pmEvent, manualMatches, decoupledPairs] = await Promise.all([
      (async () => {
        try {
          const m = await withTimeout(fetchKalshiEventMarkets(kalshiTicker), API_TIMEOUT_MS, 'Kalshi event markets');
          if (m.length > 0) {
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

    if (!pmEvent) {
      return NextResponse.json(
        { error: 'Polymarket event not found. The market may have closed or the URL may be incorrect.' },
        { status: 404 }
      );
    }

    // Check expiry: if event end date has passed AND market is no longer active,
    // return empty result with expired flag. Note: for sports markets, endDate
    // is often the match start time — the market stays live until resolution.
    const expiryDate = pmEvent.endDate;
    if (expiryDate && !force) {
      const expiryMs = new Date(expiryDate).getTime();
      const isMarketLive = pmEvent.active && !pmEvent.closed;
      if (expiryMs > 0 && expiryMs <= Date.now() && !isMarketLive) {
        return NextResponse.json({
          eventTitle: pmEvent.title,
          kalshiEventTicker: kalshiTicker,
          pmEventSlug: pmSlug,
          pmEventId: pmEvent.id,
          expiryDate,
          kalshiCount: 0,
          pmCount: 0,
          matchedCount: 0,
          kalshiRawCount: 0,
          pmRawCount: 0,
          pmFilteredCount: 0,
          kalshiFetchSource,
          clobHitCount: 0,
          clobMissCount: 0,
          outcomes: [],
          unmatchedKalshi: [],
          unmatchedPolymarket: [],
          expired: true,
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
      }
    }

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

    // Enrich markets with CLOB prices (async for neg-risk token orderbooks)
    const pmMarkets: any[] = [];
    for (const m of pmMarketsRaw) {
      const clob = clobMapLower.get(m.conditionId?.toLowerCase()) ?? clobMap.get(m.conditionId);
      if (!clob) {
        pmMarkets.push(m);
        continue;
      }
      const live = await getClobPrices(clob);
      if (!live) {
        pmMarkets.push(m);
        continue;
      }
      
      // DEBUG: Check neg_risk flag
      if (DEBUG_H2H) {
        logger.debug('[scan] CLOB neg_risk', { negRisk: clob.neg_risk, conditionId: m.conditionId?.slice(0, 12), question: m.question?.slice(0, 40) });
      }
      
      pmMarkets.push({
        ...m,
        // If CLOB has orderbook data, use it. Otherwise keep gamma's bestBid/bestAsk.
        outcomePrices: JSON.stringify([live.yesPrice.toFixed(6), live.noPrice.toFixed(6)]),
        bestBid: live.bestBid != null ? live.bestBid : m.bestBid,
        bestAsk: live.bestAsk != null ? live.bestAsk : m.bestAsk,
        lastTradePrice: live.lastTradePrice,
        noAskDepth: Number(m.liquidityNum ?? m.liquidity ?? 0),
        neg_risk: clob.neg_risk, // Preserve neg_risk flag for correct price handling
      });
    }

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

    const kalshiCount = withArbitrage.filter(o => o.kalshi).length;
    const pmCount = withArbitrage.filter(o => o.polymarket).length;
    const matchedCount = withArbitrage.filter(o => o.kalshi && o.polymarket).length;

    // Unmatched for the manual-matching UI
    const unmatchedKalshi = withArbitrage
      .filter(o => o.kalshi && !o.polymarket)
      .map(o => ({
        ticker: o.kalshi!.ticker,
        title: o.kalshi!.ticker,
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
        const bestArb = positiveArbs.length > 0
          ? positiveArbs.reduce((best, o) => o.arbitrage!.roiPct > best.arbitrage!.roiPct ? o : best)
          : null;
        const scanResult = {
          bestRoiPct: bestArb ? bestArb.arbitrage!.roiPct : 0,
          bestProfit: bestArb ? bestArb.arbitrage!.expectedProfit : 0,
          strategy: bestArb ? bestArb.arbitrage!.strategy : 'No arb',
          outcomeCount: withArbitrage.length,
          matchedCount,
          kalshiCount,
          pmCount,
          scannedAt: new Date().toISOString(),
          // UI-013: PM often keeps endDate far in the future even after a market
          // resolves. Persist PM's own closed signal so the UI can treat
          // closed-but-not-yet-past-endDate markets as expired.
          pmClosed: Boolean(pmEvent.closed) && !pmEvent.active,
          allArbs: positiveArbs.map(o => ({
            artist: o.artist,
            roiPct: o.arbitrage!.roiPct,
            expectedProfit: o.arbitrage!.expectedProfit,
            strategy: o.arbitrage!.strategy,
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
          positiveArbCount: scanResult.allArbs?.length ?? 0,
          totalStake: scanResult.allArbs?.reduce((s, a) => s + (a.totalStake ?? 0), 0) ?? 0,
          scannedAt: scanResult.scannedAt,
          raw: { allArbs: scanResult.allArbs },
          marketTitle: pmEvent.title || market.eventTitle,
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
      clobHitCount: clobMap.size,
      clobMissCount: conditionIds.length - clobMap.size,
      outcomes: withArbitrage,
      unmatchedKalshi,
      unmatchedPolymarket,
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
