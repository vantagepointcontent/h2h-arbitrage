import { NextRequest, NextResponse } from 'next/server';
import {
  extractKalshiEventTicker,
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
  KalshiMarket,
} from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, PMMarket, parseOutcomes } from '@/lib/polymarket';
import { fetchClobMarkets, getClobPrices } from '@/lib/polymarket-clob';

const API_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Extract individual market identifier from a URL.
 * Kalshi: /markets/{series}/{event}/{ticker} -> ticker
 * Polymarket: /market/{conditionId} -> conditionId
 */
function extractIndividualMarket(url: string): { type: 'kalshi' | 'polymarket'; id: string; eventUrl?: string } | null {
  const u = url.trim();
  
  // Kalshi individual market: https://kalshi.com/market/{ticker}
  const kalshiMarketMatch = u.match(/\/market\/([A-Z][A-Z0-9-]+)$/);
  if (kalshiMarketMatch) {
    return { type: 'kalshi', id: kalshiMarketMatch[1] };
  }
  
  // Kalshi event URL (contains /markets/)
  const kalshiEventMatch = u.match(/\/markets\//);
  if (kalshiEventMatch) {
    const ticker = extractKalshiEventTicker(u);
    if (ticker) return { type: 'kalshi', id: ticker, eventUrl: u };
  }
  
  // Polymarket individual market: https://polymarket.com/market/{conditionId}
  const pmMarketMatch = u.match(/\/market\/([a-f0-9-]{36})/i);
  if (pmMarketMatch) {
    return { type: 'polymarket', id: pmMarketMatch[1] };
  }
  
  // Polymarket event URL: https://polymarket.com/event/{slug}
  const pmEventMatch = u.match(/\/event\//);
  if (pmEventMatch) {
    const slug = extractPolymarketSlug(u);
    if (slug) return { type: 'polymarket', id: slug, eventUrl: u };
  }
  
  return null;
}

export interface SpreadMarket {
  name: string;
  platform: 'kalshi' | 'polymarket';
  yesAsk: number;
  noAsk: number;
  yesBid: number;
  noBid: number;
  lastPrice: number;
  isNegRisk: boolean;
  volume?: string;
  liquidity?: number;
  url: string;
}

export interface SpreadCalculation {
  spreadYes: number;       // kalshi.yesAsk - pm.yesAsk (positive = Kalshi cheaper on YES)
  spreadNo: number;        // kalshi.noAsk - pm.noAsk
  arbitrageOpportunity: 'buy_yes_kalshi_sell_yes_pm' | 'buy_yes_pm_sell_yes_kalshi' | 'none';
  roiPct: number;
  expectedProfit: number;
  kalshiStake: number;
  pmStake: number;
  totalStake: number;
  negRiskNote?: string;
}

async function fetchKalshiMarket(kalshiUrl: string): Promise<KalshiMarket[]> {
  const ticker = extractKalshiEventTicker(kalshiUrl);
  if (!ticker) return [];
  
  try {
    const markets = await withTimeout(fetchKalshiEventMarkets(ticker), API_TIMEOUT_MS, 'Kalshi event');
    if (markets.length > 0) return markets;
  } catch (e: any) {
    if (e.message?.includes('timed out')) throw e;
  }
  
  const seriesMatch = ticker.match(/^([A-Z]+)/);
  const seriesPrefix = seriesMatch ? seriesMatch[1] : null;
  if (seriesPrefix && seriesPrefix !== ticker) {
    try {
      return await withTimeout(fetchKalshiSeriesMarkets(seriesPrefix), API_TIMEOUT_MS, 'Kalshi series');
    } catch {}
  }
  
  try {
    return await withTimeout(fetchKalshiSeriesMarkets(ticker), API_TIMEOUT_MS, 'Kalshi series');
  } catch {}
  
  return [];
}

function findKalshiByUrl(allMarkets: KalshiMarket[], url: string): KalshiMarket | null {
  const marketMatch = url.match(/\/market\/([A-Z][A-Z0-9-]+)$/);
  if (marketMatch) {
    const ticker = marketMatch[1];
    return allMarkets.find(m => m.ticker === ticker) || null;
  }
  return null;
}

function buildKalshiSpreadShape(km: KalshiMarket, url: string): SpreadMarket {
  return {
    name: km.title || km.ticker,
    platform: 'kalshi',
    yesAsk: parseFloat(km.yes_ask_dollars || '1'),
    noAsk: parseFloat(km.no_ask_dollars || '1'),
    yesBid: parseFloat(km.yes_bid_dollars || '0'),
    noBid: parseFloat(km.no_bid_dollars || '0'),
    lastPrice: parseFloat(km.last_price_dollars || '0'),
    isNegRisk: false,
    volume: km.volume_24h_fp || undefined,
    url,
  };
}

async function fetchPolymarketMarket(pmUrl: string): Promise<{ markets: PMMarket[]; eventTitle: string }> {
  const slug = extractPolymarketSlug(pmUrl);
  if (!slug) return { markets: [], eventTitle: '' };
  
  const event = await withTimeout(fetchPolymarketEvent(slug), API_TIMEOUT_MS, 'Polymarket event');
  if (!event) return { markets: [], eventTitle: '' };
  return { markets: event.markets || [], eventTitle: event.title };
}

function findPMByUrl(markets: PMMarket[], url: string): PMMarket | null {
  const marketMatch = url.match(/\/market\/([a-f0-9-]{36})/i);
  if (marketMatch) {
    const conditionId = marketMatch[1];
    return markets.find(m => m.conditionId === conditionId) || null;
  }
  return null;
}

function buildPMSpreadShape(pm: PMMarket, url: string, clobLive?: Awaited<ReturnType<typeof getClobPrices>>): SpreadMarket {
  const { prices } = parseOutcomes(pm);
  const isNegRisk = pm.neg_risk === true;
  
  const rawBestAsk = pm.bestAsk;
  const rawBestBid = pm.bestBid;
  const hasOrderbook = !(rawBestAsk != null && rawBestBid != null && rawBestAsk >= 0.99 && rawBestBid <= 0.01);
  
  let yesPrice: number;
  let noPrice: number;
  
  if (!hasOrderbook) {
    yesPrice = prices[0] ?? 0;
    noPrice = prices[1] ?? (1 - yesPrice);
  } else if (isNegRisk && clobLive) {
    yesPrice = clobLive.yesPrice;
    noPrice = clobLive.noPrice;
  } else if (isNegRisk) {
    yesPrice = prices[0] ?? 0;
    noPrice = prices[1] ?? 0;
  } else if (rawBestAsk != null && rawBestBid != null) {
    yesPrice = rawBestAsk;
    noPrice = 1 - rawBestBid;
  } else if (rawBestAsk != null) {
    yesPrice = rawBestAsk;
    noPrice = 1 - rawBestAsk;
  } else if (rawBestBid != null) {
    yesPrice = 1 - rawBestBid;
    noPrice = rawBestBid;
  } else {
    yesPrice = prices[0] ?? 0;
    noPrice = prices[1] ?? (1 - yesPrice);
  }
  
  return {
    name: pm.groupItemTitle || pm.question || pm.conditionId?.slice(0, 12),
    platform: 'polymarket',
    yesAsk: yesPrice,
    noAsk: noPrice,
    yesBid: 1 - noPrice,
    noBid: 1 - yesPrice,
    lastPrice: pm.lastTradePrice ?? yesPrice,
    isNegRisk,
    liquidity: Number(pm.liquidityNum ?? pm.liquidity ?? 0),
    url,
  };
}

function calculateSpread(kalshi: SpreadMarket, polymarket: SpreadMarket, capital: number): SpreadCalculation {
  const kYes = kalshi.yesAsk;
  const kNo = kalshi.noAsk;
  const pYes = polymarket.yesAsk;
  const pNo = polymarket.noAsk;
  
  const spreadYes = +(kYes - pYes).toFixed(4);
  const spreadNo = +(kNo - pNo).toFixed(4);
  
  // Determine arbitrage direction
  // Strategy A: Buy YES on Kalshi, Sell YES (= Buy NO) on PM -> profit if kYes + pNo < 1
  const stratAProfit = 1 - (kYes + pNo);
  // Strategy B: Buy YES on PM, Sell YES (= Buy NO) on Kalshi -> profit if pYes + kNo < 1
  const stratBProfit = 1 - (pYes + kNo);
  
  let arbitrageOpportunity: SpreadCalculation['arbitrageOpportunity'] = 'none';
  let roiPct = 0;
  let expectedProfit = 0;
  let kalshiStake = 0;
  let pmStake = 0;
  
  if (stratAProfit > stratBProfit && stratAProfit > 0) {
    arbitrageOpportunity = 'buy_yes_kalshi_sell_yes_pm';
    // Capital allocated proportionally: stake on each side = capital/2 per side
    const halfCapital = capital / 2;
    kalshiStake = halfCapital; // Buy YES Kalshi
    pmStake = halfCapital;    // Buy NO PM (= Sell YES PM)
    expectedProfit = halfCapital * stratAProfit;
    roiPct = stratAProfit * 100;
  } else if (stratBProfit > 0) {
    arbitrageOpportunity = 'buy_yes_pm_sell_yes_kalshi';
    const halfCapital = capital / 2;
    kalshiStake = halfCapital; // Buy NO Kalshi (= Sell YES Kalshi)
    pmStake = halfCapital;     // Buy YES PM
    expectedProfit = halfCapital * stratBProfit;
    roiPct = stratBProfit * 100;
  }
  
  const totalStake = kalshiStake + pmStake;
  
  const negRiskNote = (kalshi.isNegRisk || polymarket.isNegRisk)
    ? 'Contains neg-risk market: outcomes priced independently (not constrained to sum to $1)'
    : undefined;
  
  return {
    spreadYes,
    spreadNo,
    arbitrageOpportunity,
    roiPct,
    expectedProfit,
    kalshiStake,
    pmStake,
    totalStake,
    ...(negRiskNote ? { negRiskNote } : {}),
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { kalshiUrl, polymarketUrl, capital = 1000 } = body;
    
    if (!kalshiUrl || !polymarketUrl) {
      return NextResponse.json({ error: 'Both kalshiUrl and polymarketUrl are required' }, { status: 400 });
    }
    
    // Fetch both markets in parallel
    const [kalshiMarkets, pmData] = await Promise.all([
      fetchKalshiMarket(kalshiUrl),
      fetchPolymarketMarket(polymarketUrl),
    ]);
    
    // Find individual markets if URLs point to specific markets
    const kalshiMarket = findKalshiByUrl(kalshiMarkets, kalshiUrl);
    const pmMarket = findPMByUrl(pmData.markets, polymarketUrl);
    
    // If individual market URLs were used but not found, try to find by name matching
    let kalshi: KalshiMarket | null = kalshiMarket;
    let pm: PMMarket | null = pmMarket;
    
    if (!kalshi && kalshiMarkets.length > 0) {
      // For event URLs, just return all markets for the frontend to choose
      // For individual market URLs, try fuzzy matching
      kalshi = kalshiMarkets[0];
    }
    
    if (!pm && pmData.markets.length > 0) {
      pm = pmData.markets[0];
    }
    
    if (!kalshi && !pm) {
      return NextResponse.json({ error: 'Could not find markets. Check URLs.' }, { status: 404 });
    }
    
    // Enrich Polymarket with CLOB prices
    let clobLive: Awaited<ReturnType<typeof getClobPrices>> | undefined;
    if (pm?.conditionId) {
      const clobResult = await fetchClobMarkets([pm.conditionId]);
      const clob = clobResult.get(pm.conditionId);
      if (clob) {
        clobLive = await getClobPrices(clob);
      }
    }
    
    const kalshiShape = buildKalshiSpreadShape(kalshi!, kalshiUrl);
    const pmShape = pm ? buildPMSpreadShape(pm, polymarketUrl, clobLive) : null;
    
    let spreadCalc: SpreadCalculation | null = null;
    if (pmShape) {
      spreadCalc = calculateSpread(kalshiShape, pmShape, capital);
    }
    
    // Also gather ALL outcomes from both events for the frontend to pick from
    const allKalshi = kalshiMarkets.map(km => ({
      ticker: km.ticker,
      title: km.title || km.ticker,
      yesAsk: parseFloat(km.yes_ask_dollars || '1'),
      noAsk: parseFloat(km.no_ask_dollars || '1'),
      yesBid: parseFloat(km.yes_bid_dollars || '0'),
      noBid: parseFloat(km.no_bid_dollars || '0'),
      lastPrice: parseFloat(km.last_price_dollars || '0'),
      volume: km.volume_24h_fp,
    }));
    
    const allPM = pmData.markets.map((m, idx) => {
      const { prices } = parseOutcomes(m);
      return {
        conditionId: m.conditionId,
        marketId: m.id,
        title: m.groupItemTitle || m.question || `Market ${idx + 1}`,
        yesPrice: prices[0] ?? 0,
        noPrice: prices[1] ?? (1 - (prices[0] ?? 0)),
        bestAsk: m.bestAsk ?? prices[0] ?? 0,
        bestBid: m.bestBid ?? prices[0] ?? 0,
        lastTradePrice: m.lastTradePrice ?? prices[0] ?? 0,
        isNegRisk: m.neg_risk === true,
        liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0),
      };
    });
    
    return NextResponse.json({
      kalshi: kalshiShape,
      polymarket: pmShape,
      spread: spreadCalc,
      allKalshi,
      allPM,
      pmEventTitle: pmData.eventTitle,
      _ts: Date.now(),
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (err: any) {
    console.error('[spread-api-error]', err);
    const msg = err.message || 'Unknown error';
    const status = msg.includes('timed out') ? 504 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function GET(request: NextRequest) {
  // Support GET for easy testing
  const url = new URL(request.url);
  const kalshiUrl = url.searchParams.get('kalshiUrl');
  const polymarketUrl = url.searchParams.get('polymarketUrl');
  const capital = parseInt(url.searchParams.get('capital') || '1000');
  
  if (!kalshiUrl || !polymarketUrl) {
    return NextResponse.json({ error: 'kalshiUrl and polymarketUrl query params required' }, { status: 400 });
  }
  
  return POST(new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kalshiUrl, polymarketUrl, capital }),
  }));
}
