import { NextRequest, NextResponse } from 'next/server';
import { rateLimiters } from '@/lib/rate-limiter';
import { createTtlMemo } from '@/lib/ttl-cache';
import { clientSafeError } from '@/lib/error-handler';
import { getPredictionHuntMarkets } from '@/lib/predictionhunt';

/* ═══════════════════════════════════════════════════════════════
   GET /api/all-markets
   Returns all active Kalshi + Polymarket markets for the manual
   matching panel. Uses a 60s TTL cache to avoid hammering APIs.

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
  source: 'api' | 'predictionhunt';
}

const allMarketsMemo = createTtlMemo<AllMarketsResponse>(60_000); // 60s TTL

async function fetchKalshiAllMarkets(): Promise<KalshiMarketLite[]> {
  const all: KalshiMarketLite[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 10; page++) {
    const url = new URL('https://external-api.kalshi.com/trade-api/v2/markets');
    url.searchParams.set('status', 'open');
    url.searchParams.set('limit', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await rateLimiters.kalshi.execute(() =>
      fetch(url.toString(), {
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      }),
    );
    if (!res.ok) break;

    const data = await res.json();
    const markets: any[] = data.markets || [];
    if (markets.length === 0) break;

    for (const m of markets) {
      const title = m.title || m.subtitle || m.yes_sub_title || m.ticker;
      const yesAsk = m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : NaN;
      const noAsk = m.no_ask_dollars ? parseFloat(m.no_ask_dollars) : NaN;
      all.push({
        ticker: m.ticker,
        title,
        yesAsk: isNaN(yesAsk) ? 0 : yesAsk,
        noAsk: isNaN(noAsk) ? 0 : noAsk,
        eventTicker: m.event_ticker || null,
        closeTime: m.close_time || null,
      });
    }

    cursor = data.cursor || null;
    if (!cursor) break;
  }

  return all;
}

async function fetchPolymarketAllMarkets(): Promise<PolymarketLite[]> {
  const all: PolymarketLite[] = [];
  let offset = 0;
  const limit = 100; // gamma API max per page

  for (let page = 0; page < 50; page++) { // up to 5000 markets
    const url = new URL('https://gamma-api.polymarket.com/markets');
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const res = await rateLimiters.gamma.execute(() =>
      fetch(url.toString(), {
        headers: { 'Accept': 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      }),
    );
    if (!res.ok) break;

    const data = await res.json();
    const markets: any[] = Array.isArray(data) ? data : (data.markets || []);
    if (markets.length === 0) break;

    for (const m of markets) {
      // Parse outcome prices
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

      all.push({
        conditionId: m.conditionId || m.id,
        slug: m.slug || '',
        title: m.question || m.groupItemTitle || m.slug || m.id,
        yesPrice,
        noPrice,
        endDate: m.endDate || null,
      });
    }

    if (markets.length < limit) break;
    offset += limit;
  }

  return all;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const usePH = searchParams.get('source') === 'predictionhunt';

    const result = await allMarketsMemo('all-markets', async () => {
      // Try direct API fetch first (most up-to-date)
      if (!usePH) {
        try {
          const [kalshi, polymarket] = await Promise.all([
            fetchKalshiAllMarkets(),
            fetchPolymarketAllMarkets(),
          ]);

          if (kalshi.length > 0 || polymarket.length > 0) {
            return {
              kalshi,
              polymarket,
              cached: false,
              source: 'api' as const,
            };
          }
        } catch (e: any) {
          console.warn('[all-markets] Direct API fetch failed, falling back to PredictionHunt cache:', e.message);
        }
      }

      // Fallback: use cached PredictionHunt data
      const phMarkets = await getPredictionHuntMarkets();

      const kalshiMap = new Map<string, KalshiMarketLite>();
      const pmMap = new Map<string, PolymarketLite>();

      for (const m of phMarkets) {
        // Kalshi markets from PH
        if (m.kalshiUrl && m.kalshiId) {
          const ticker = m.kalshiId;
          if (!kalshiMap.has(ticker)) {
            kalshiMap.set(ticker, {
              ticker,
              title: m.title,
              yesAsk: m.kalshiPrice?.yesAsk ?? 0,
              noAsk: 0,
              eventTicker: null,
              closeTime: m.eventDate,
            });
          }
        }

        // Polymarket markets from PH
        if (m.polymarketUrl && m.polymarketId) {
          const cid = m.polymarketId;
          if (!pmMap.has(cid)) {
            pmMap.set(cid, {
              conditionId: cid,
              slug: m.polymarketUrl?.split('/').pop() || '',
              title: m.title,
              yesPrice: m.pmPrice?.yesAsk ?? 0,
              noPrice: 0,
              endDate: m.eventDate,
            });
          }
        }
      }

      return {
        kalshi: Array.from(kalshiMap.values()),
        polymarket: Array.from(pmMap.values()),
        cached: true,
        source: 'predictionhunt' as const,
      };
    });

    // The memo always returns cached=true after first call within TTL window
    // Override to reflect actual cache state (first call in window = fresh)
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