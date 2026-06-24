import { NextRequest, NextResponse } from 'next/server';
import logger from '@/lib/logger';
import {
  extractKalshiEventTicker,
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent } from '@/lib/polymarket';
import { fetchClobMarkets, getClobPrices } from '@/lib/polymarket-clob';
import { matchOutcomes, calculateAllArbitrages, parseDepth, computeApy, applyManualMatches } from '@/lib/matcher';
import { getManualMatches } from '@/lib/manual-matches';
import { getSavedMarkets, updateSavedMarketScanResult, appendScanHistory } from '@/lib/persistence';

const API_TIMEOUT_MS = 15000; // 15s timeout for upstream APIs
const DEBUG_H2H = process.env.DEBUG_H2H === '1' || process.env.DEBUG_H2H === 'true';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Try both Polymarket structures:
 * (A) markets that have a groupItemTitle (named binary)
 * (B) markets that have NO groupItemTitle (unnamed binary)
 * If both are non-empty, run matching on each and return the one that yields more matched outcomes.
 * If the winner set is empty, fall back to the full set.
 */
function chooseBestPmStructure(
  allPmMarkets: any[],
  kalshiMarkets: any[],
  pmEventTitle: string,
): any[] {
  const namedMarkets = allPmMarkets.filter((m: any) =>
    m.groupItemTitle && m.groupItemTitle !== '' && m.groupItemTitle !== 'N/A'
  );
  const unnamedMarkets = allPmMarkets.filter((m: any) =>
    !m.groupItemTitle || m.groupItemTitle === '' || m.groupItemTitle === 'N/A'
  );

  if (namedMarkets.length === 0) return unnamedMarkets;
  if (unnamedMarkets.length === 0) return namedMarkets;

  // Run matching on both sets and count matched outcomes
  const namedOutcomes = matchOutcomes(kalshiMarkets, namedMarkets, pmEventTitle, 1000);
  const unnamedOutcomes = matchOutcomes(kalshiMarkets, unnamedMarkets, pmEventTitle, 1000);

  const namedMatched = namedOutcomes.filter((o: any) => o.kalshi && o.polymarket).length;
  const unnamedMatched = unnamedOutcomes.filter((o: any) => o.kalshi && o.polymarket).length;

  if (namedMatched === 0 && unnamedMatched === 0) return allPmMarkets;
  if (namedMatched >= unnamedMatched) return namedMarkets;
  return unnamedMarkets;
}

export async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { kalshiUrl, polymarketUrl } = body;

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
    const [kalshiMarkets, pmEvent, manualMatches] = await Promise.all([
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
      withTimeout(fetchPolymarketEvent(pmSlug), API_TIMEOUT_MS, 'Polymarket event'),
      getManualMatches(),
    ]);

    if (!pmEvent) {
      return NextResponse.json(
        { error: 'Polymarket event not found. The market may have closed or the URL may be incorrect.' },
        { status: 404 }
      );
    }

    // Check expiry: if event end date has passed, return empty result with expired flag
    const expiryDate = pmEvent.endDate;
    if (expiryDate) {
      const expiryMs = new Date(expiryDate).getTime();
      if (expiryMs > 0 && expiryMs <= Date.now()) {
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
      clobMap = await withTimeout(
        fetchClobMarkets(conditionIds.slice(0, 6)),
        API_TIMEOUT_MS,
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

    // Step 1: auto-match
    const kalshiRawCount = kalshiMarkets.length;
    const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent.title, 1000, pmEvent.endDate);

    // Step 2: apply manual matches to merge auto-unmatched pairs
    const outcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, 1000, pmEvent.endDate);

    // Step 3: compute arbitrage (with depth awareness) for all matched items, including cross-outcome
    const withArbitrage = calculateAllArbitrages(outcomes, pmEvent.title).map(o => ({
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
      const allMarkets = await getSavedMarkets();
      const market = allMarkets.find(m => m.kalshiUrl === kalshiUrl && m.polymarketUrl === polymarketUrl);
      if (market) {
        const positiveArbs = withArbitrage.filter(o => o.arbitrage && o.arbitrage.roiPct > 0);
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
        // Record in global scan history
        await appendScanHistory({
          scanTimestamp: new Date().toISOString(),
          marketId: market.id,
          totalProfit: positiveArbs.reduce((s, a) => s + a.arbitrage!.expectedProfit, 0),
          bestRoiPct: bestArb ? bestArb.arbitrage!.roiPct : 0,
          positiveArbCount: positiveArbs.length,
          matchedCount,
        });
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
    const msg = err.message || 'Unknown error';
    const status = msg.includes('timed out') ? 504 : msg.includes('not found') ? 404 : 500;
    return NextResponse.json(
      { error: msg },
      { status }
    );
  }
}
