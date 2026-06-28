import { NextRequest } from 'next/server';
import { clobWs } from '@/lib/clob-ws';
import { kalshiWs, KalshiWsMessage } from '@/lib/kalshi-ws';
import { orderbookState } from '@/lib/orderbook-state';
import { computeAllLiveArbitrages, applyPolymarketBook, LiveMatchedOutcome } from '@/lib/live-arb-engine';
import { makeKalshiAuthHeaders } from '@/lib/kalshi-auth';
import { extractKalshiEventTicker, fetchKalshiEventMarkets, KalshiMarket } from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl, PMMarket } from '@/lib/polymarket';
import { matchOutcomes } from '@/lib/matcher';
import logger from '@/lib/logger';

export const dynamic = 'force-dynamic';

interface PmToken {
  outcome: string;
  token_id: string;
}

// Per-request runtime state — isolated by request so closing the SSE shuts everything down.
interface LiveScanSession {
  matchedOutcomes: LiveMatchedOutcome[];
  kalshiTickers: string[];
  pmTokenIds: string[];
  capital: number;
  category?: string;
  closed: boolean;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const kalshiUrl = searchParams.get('kalshiUrl') || '';
  const pmUrl = searchParams.get('pmUrl') || '';
  const capital = Number(searchParams.get('capital') || '10');

  if (!kalshiUrl || !pmUrl) {
    return new Response('Missing kalshiUrl or pmUrl', { status: 400 });
  }

  const kalshiEventTicker = extractKalshiEventTicker(kalshiUrl);
  const pmSlug = extractPolymarketSlug(pmUrl);

  if (!kalshiEventTicker) {
    return new Response('Could not extract Kalshi event ticker from URL', { status: 400 });
  }
  if (!pmSlug) {
    return new Response('Could not extract Polymarket slug from URL', { status: 400 });
  }

  // ── Resolve ALL Kalshi markets for the event (with fallbacks, same as scan route) ──
  let kalshiMarkets: KalshiMarket[] = [];
  try {
    kalshiMarkets = await fetchKalshiEventMarkets(kalshiEventTicker);
    if (kalshiMarkets.length === 0) {
      // Fallback: try series prefix
      const seriesMatch = kalshiEventTicker.match(/^([A-Z]+)/);
      const seriesFallback = seriesMatch ? seriesMatch[1] : null;
      if (seriesFallback && seriesFallback !== kalshiEventTicker) {
        const { fetchKalshiSeriesMarkets } = await import('@/lib/kalshi');
        kalshiMarkets = await fetchKalshiSeriesMarkets(seriesFallback);
      }
      if (kalshiMarkets.length === 0 && kalshiEventTicker) {
        const { fetchKalshiSeriesMarkets } = await import('@/lib/kalshi');
        kalshiMarkets = await fetchKalshiSeriesMarkets(kalshiEventTicker);
      }
    }
  } catch (err) {
    logger.error('[live-scan] failed to fetch Kalshi event markets', { err, kalshiEventTicker });
    return new Response('Failed to fetch Kalshi event markets', { status: 500 });
  }

  // ── Resolve ALL Polymarket markets for the event ──
  let pmEvent: Awaited<ReturnType<typeof fetchPolymarketEvent>> | null = null;
  let pmMarkets: PMMarket[] = [];
  let category: string | undefined;

  try {
    pmEvent = await (isPolymarketMarketUrl(pmUrl)
      ? fetchPolymarketMarketAsEvent(pmSlug)
      : fetchPolymarketEvent(pmSlug));
    if (!pmEvent) {
      return new Response('Polymarket event not found', { status: 400 });
    }
    pmMarkets = pmEvent.markets || [];
    // Pick category from first market or event title
    category = pmMarkets[0]?.groupItemTitle || pmEvent?.title;
  } catch (err) {
    logger.error('[live-scan] failed to resolve Polymarket event', { err, pmUrl });
    return new Response('Failed to resolve Polymarket event', { status: 500 });
  }

  // ── Match outcomes (same logic as scan route) ──
  const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent?.title, capital);

  // Filter to only fully matched outcomes (both Kalshi and PM present)
  const matched = baseOutcomes.filter((o) => o.kalshi && o.polymarket);

  if (matched.length === 0) {
    return new Response('No matching outcomes found between Kalshi and Polymarket', { status: 400 });
  }

  // ── Resolve Polymarket token IDs for ALL matched markets ──
  const conditionIds = [...new Set(matched.map((o) => o.polymarket!.conditionId))];
  const tokenMap = new Map<string, { yes: string; no: string }>();

  for (const cid of conditionIds) {
    try {
      const clobRes = await fetch(`https://clob.polymarket.com/markets/${cid}`, { cache: 'no-store' });
      if (!clobRes.ok) continue;
      const clobMarket = await clobRes.json() as { tokens?: PmToken[] };
      const tokens = clobMarket.tokens || [];
      const yes = tokens.find((t) => t.outcome.toLowerCase() === 'yes');
      const no = tokens.find((t) => t.outcome.toLowerCase() === 'no');
      if (yes && no) {
        tokenMap.set(cid, { yes: yes.token_id, no: no.token_id });
      }
    } catch (err) {
      logger.warn('[live-scan] failed to fetch CLOB tokens', { cid, err });
    }
  }

  // Build matched outcomes with resolved token IDs
  const liveMatched: LiveMatchedOutcome[] = [];
  const allKalshiTickers = new Set<string>();
  const allPmTokenIds = new Set<string>();

  for (const o of matched) {
    const cid = o.polymarket!.conditionId;
    const tokens = tokenMap.get(cid);
    if (!tokens) continue;

    const outcome: LiveMatchedOutcome = {
      artist: o.artist,
      kalshiTicker: o.kalshi!.ticker,
      pmYesTokenId: tokens.yes,
      pmNoTokenId: tokens.no,
    };
    liveMatched.push(outcome);
    allKalshiTickers.add(o.kalshi!.ticker);
    allPmTokenIds.add(tokens.yes);
    allPmTokenIds.add(tokens.no);
  }

  if (liveMatched.length === 0) {
    return new Response('Could not resolve Polymarket token IDs for matched outcomes', { status: 400 });
  }

  const session: LiveScanSession = {
    matchedOutcomes: liveMatched,
    kalshiTickers: [...allKalshiTickers],
    pmTokenIds: [...allPmTokenIds],
    capital,
    category,
    closed: false,
  };

  const encoder = new TextEncoder();
  let lastSend = 0;
  const minIntervalMs = 250; // throttle UI updates

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        if (session.closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: 'status', message: 'Connecting to exchanges...' });

      // Seed ALL books from REST so UI shows prices immediately
      seedAllBooks(session.kalshiTickers, session.pmTokenIds)
        .then(() => maybeSendResults())
        .catch(() => {});

      // ── Kalshi WS: subscribe to ALL tickers ──
      const kalshiSubKey = `live-scan-kalshi-${Date.now()}`;
      kalshiWs.connect();
      kalshiWs.subscribe(
        session.kalshiTickers[0], // subscribe callback receives all tickers
        (msg: KalshiWsMessage) => {
          if (session.closed) return;
          if (msg.type === 'orderbook_snapshot') {
            orderbookState.setBook(msg.marketTicker, msg.yes, msg.no, msg.seq);
          } else if (msg.type === 'orderbook_delta') {
            orderbookState.applyAskDelta(msg.marketTicker, msg.side, msg.price, msg.delta, msg.seq);
          }
          maybeSendResults();
        },
        kalshiSubKey,
      );

      // Subscribe additional Kalshi tickers beyond the first one
      for (let i = 1; i < session.kalshiTickers.length; i++) {
        const extraKey = `live-scan-kalshi-extra-${session.kalshiTickers[i]}-${Date.now()}-${i}`;
        kalshiWs.subscribe(
          session.kalshiTickers[i],
          (msg: KalshiWsMessage) => {
            if (session.closed) return;
            if (msg.type === 'orderbook_snapshot') {
              orderbookState.setBook(msg.marketTicker, msg.yes, msg.no, msg.seq);
            } else if (msg.type === 'orderbook_delta') {
              orderbookState.applyAskDelta(msg.marketTicker, msg.side, msg.price, msg.delta, msg.seq);
            }
            maybeSendResults();
          },
          extraKey,
        );
      }

      // ── Polymarket WS: subscribe to ALL token IDs ──
      const pmSubKey = `live-scan-pm-${Date.now()}`;
      clobWs.connect();
      clobWs.subscribe(session.pmTokenIds, (updates) => {
        if (session.closed) return;
        for (const u of updates) {
          if (u.type === 'book' && u.book) {
            applyPolymarketBook(u.tokenId, u.book.asks.map((a) => ({ price: String(a.price), size: String(a.size) })));
          } else if (u.bestAsk != null) {
            orderbookState.setBook(u.tokenId, [{ price: u.bestAsk, quantity: Infinity }], [], u.ts);
          }
        }
        maybeSendResults();
      }, pmSubKey);

      function maybeSendResults() {
        const now = Date.now();
        if (now - lastSend < minIntervalMs) return;
        lastSend = now;
        const outcomes = computeAllLiveArbitrages(session.matchedOutcomes, session.capital, session.category);
        send({ type: 'result', result: { outcomes, lastUpdate: new Date().toISOString() } });
      }

      // Periodic heartbeat even if no updates
      const heartbeat = setInterval(() => {
        if (session.closed) return;
        maybeSendResults();
      }, 1000);

      // Cleanup when client disconnects
      req.signal.addEventListener('abort', () => {
        session.closed = true;
        clearInterval(heartbeat);

        // Unsubscribe ALL Kalshi subscriptions
        kalshiWs.unsubscribe(kalshiSubKey);
        for (let i = 1; i < session.kalshiTickers.length; i++) {
          const extraKey = `live-scan-kalshi-extra-${session.kalshiTickers[i]}-${Date.now()}-${i}`;
          kalshiWs.unsubscribe(extraKey);
        }

        // Unsubscribe Polymarket
        clobWs.unsubscribe(pmSubKey);

        // Clean up orderbook state
        for (const t of session.kalshiTickers) orderbookState.removeBook(t);
        for (const t of session.pmTokenIds) orderbookState.removeBook(t);

        try {
          controller.close();
        } catch { /* ignore */ }
      });
    },
    cancel() {
      session.closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// ── Seeding helpers ──

async function seedAllBooks(tickers: string[], tokenIds: string[]): Promise<void> {
  await Promise.all([
    ...tickers.map(seedKalshiBook),
    ...tokenIds.map(seedPmBook),
  ]);
}

async function seedPmBook(tokenId: string) {
  try {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    applyPolymarketBook(tokenId, (data.asks || []).map((a: any) => ({ price: String(a.price), size: String(a.size) })));
  } catch (err) {
    logger.warn('[live-scan] failed to seed PM book', { tokenId, err });
  }
}

async function seedKalshiBook(ticker: string) {
  try {
    const res = await fetch(
      `https://external-api.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`,
      { headers: makeKalshiAuthHeaders('GET', `/trade-api/v2/markets/${ticker}/orderbook`), cache: 'no-store' },
    );
    if (!res.ok) return;
    const data = await res.json() as {
      orderbook?: { yes_dollars_fp?: [string, string][]; no_dollars_fp?: [string, string][] };
      orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
    };
    const yesRaw = data.orderbook?.yes_dollars_fp ?? data.orderbook_fp?.yes_dollars ?? [];
    const noRaw = data.orderbook?.no_dollars_fp ?? data.orderbook_fp?.no_dollars ?? [];
    const yes = yesRaw
      .map(([p, q]) => ({ price: parseFloat(p), quantity: parseFloat(q) }))
      .filter((lvl) => lvl.quantity > 0);
    const no = noRaw
      .map(([p, q]) => ({ price: parseFloat(p), quantity: parseFloat(q) }))
      .filter((lvl) => lvl.quantity > 0);
    orderbookState.setBook(ticker, yes, no);
  } catch (err) {
    logger.warn('[live-scan] failed to seed Kalshi book', { ticker, err });
  }
}
