import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { extractKalshiEventTicker, fetchKalshiEventMarkets, fetchKalshiSeriesMarkets } from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl } from '@/lib/polymarket';

/* ═══════════════════════════════════════════════════════════════
   GET /api/all-markets?kalshiUrl=...&pmUrl=...
   Returns all markets that belong to the specific Kalshi event and
   Polymarket event referenced by the provided URLs.

   This is event-scoped, NOT global. "All markets" means all outcomes
   from the two linked events, not every market on the platform.

   Response:
   {
     kalshi: [{ ticker, title, yesAsk, noAsk, eventTicker, closeTime }],
     polymarket: [{ conditionId, slug, title, yesPrice, noPrice, endDate }],
     cached: boolean
   }
   ═══════════════════════════════════════════════════════════════ */

interface KalshiMarketLite {
  ticker: string;
  title: string;
  yesAsk: number;
  noAsk: number;
  eventTicker: string | null;
  closeTime: string | null;
}

interface PolymarketLite {
  conditionId: string;
  slug: string;
  title: string;
  yesPrice: number;
  noPrice: number;
  endDate: string | null;
}

interface AllMarketsResponse {
  kalshi: KalshiMarketLite[];
  polymarket: PolymarketLite[];
  cached: boolean;
  source: string;
}

async function fetchKalshiEventScoped(kalshiUrl: string): Promise<KalshiMarketLite[]> {
  const eventTicker = extractKalshiEventTicker(kalshiUrl);
  if (!eventTicker) return [];

  // Fetch all markets for this event
  const markets = await fetchKalshiEventMarkets(eventTicker);

  if (markets.length === 0) {
    // Fallback: try series_ticker (first segment is the series)
    const seriesMatch = kalshiUrl.match(/kalshi\.com\/markets\/([^\/]+)/);
    if (seriesMatch) {
      const seriesTicker = seriesMatch[1].toUpperCase();
      const seriesMarkets = await fetchKalshiSeriesMarkets(seriesTicker);
      return seriesMarkets.map(m => ({
        ticker: m.ticker,
        title: m.title || m.yes_sub_title || m.ticker,
        yesAsk: m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : 0,
        noAsk: m.no_ask_dollars ? parseFloat(m.no_ask_dollars) : 0,
        eventTicker: m.event_ticker || null,
        closeTime: m.close_time || null,
      }));
    }
    return [];
  }

  return markets.map(m => ({
    ticker: m.ticker,
    title: m.title || m.yes_sub_title || m.ticker,
    yesAsk: m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : 0,
    noAsk: m.no_ask_dollars ? parseFloat(m.no_ask_dollars) : 0,
    eventTicker: m.event_ticker || eventTicker,
    closeTime: m.close_time || null,
  }));
}

async function fetchPolymarketEventScoped(pmUrl: string): Promise<PolymarketLite[]> {
  const slug = extractPolymarketSlug(pmUrl);
  if (!slug) return [];

  // For /market/ URLs, use fetchPolymarketMarketAsEvent (resolves parent event)
  // For /event/ URLs, use fetchPolymarketEvent directly
  let pmEvent;
  if (isPolymarketMarketUrl(pmUrl)) {
    pmEvent = await fetchPolymarketMarketAsEvent(slug);
  } else {
    pmEvent = await fetchPolymarketEvent(slug);
  }

  if (!pmEvent || !pmEvent.markets) return [];

  return pmEvent.markets.map(m => {
    let yesPrice = 0;
    let noPrice = 0;
    try {
      const prices = typeof m.outcomePrices === 'string'
        ? JSON.parse(m.outcomePrices) as string[]
        : m.outcomePrices;
      if (Array.isArray(prices) && prices.length >= 2) {
        yesPrice = parseFloat(prices[0]) || 0;
        noPrice = parseFloat(prices[1]) || 0;
      }
    } catch { /* ignore parse errors */ }

    return {
      conditionId: m.conditionId || m.id,
      slug: m.slug || '',
      title: m.question || m.groupItemTitle || m.slug || m.id,
      yesPrice,
      noPrice,
      endDate: m.endDate || null,
    };
  });
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const kalshiUrl = searchParams.get('kalshiUrl');
    const pmUrl = searchParams.get('pmUrl');

    // If no URLs provided, return empty (don't fetch global market lists)
    if (!kalshiUrl && !pmUrl) {
      return NextResponse.json({
        kalshi: [],
        polymarket: [],
        cached: false,
        source: 'event-scoped',
      } as AllMarketsResponse, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        },
      });
    }

    // Fetch event-scoped markets in parallel
    const [kalshi, polymarket] = await Promise.all([
      kalshiUrl ? fetchKalshiEventScoped(kalshiUrl).catch(() => []) : Promise.resolve([] as KalshiMarketLite[]),
      pmUrl ? fetchPolymarketEventScoped(pmUrl).catch(() => []) : Promise.resolve([] as PolymarketLite[]),
    ]);

    const result: AllMarketsResponse = {
      kalshi,
      polymarket,
      cached: false,
      source: 'event-scoped',
    };

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: any) {
    console.error('[api/all-markets GET]', err);
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}