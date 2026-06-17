import { NextRequest } from 'next/server';
import { clobWs } from '@/lib/clob-ws';
import { kalshiWs } from '@/lib/kalshi-ws';
import { orderbookState } from '@/lib/orderbook-state';
import { computeLiveArbitrage, applyPolymarketBook } from '@/lib/live-arb-engine';
import { makeKalshiAuthHeaders } from '@/lib/kalshi-auth';
import { extractKalshiTicker } from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent } from '@/lib/polymarket';
import logger from '@/lib/logger';

export const dynamic = 'force-dynamic';

interface PmToken {
  outcome: string;
  token_id: string;
}

// Per-request runtime state — isolated by request so closing the SSE shuts everything down.
interface LiveScanSession {
  pmYesTokenId: string;
  pmNoTokenId: string;
  kalshiTicker: string;
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

  const kalshiTicker = extractKalshiTicker(kalshiUrl);
  const pmSlug = extractPolymarketSlug(pmUrl);

  if (!kalshiTicker) {
    return new Response('Could not extract Kalshi ticker from URL', { status: 400 });
  }
  if (!pmSlug) {
    return new Response('Could not extract Polymarket slug from URL', { status: 400 });
  }

  // Resolve Polymarket token IDs
  let pmYesTokenId = '';
  let pmNoTokenId = '';
  let pmConditionId = '';
  let category: string | undefined;
  try {
    const event = await fetchPolymarketEvent(pmSlug);
    const market = event?.markets?.[0];
    if (!market) {
      return new Response('Polymarket event not found', { status: 400 });
    }
    pmConditionId = market.conditionId;
    category = market.groupItemTitle || event?.title;

    // Tokens are not exposed on gamma events; fetch from CLOB market endpoint.
    const clobRes = await fetch(`https://clob.polymarket.com/markets/${pmConditionId}`, { cache: 'no-store' });
    if (!clobRes.ok) {
      return new Response('Failed to fetch Polymarket CLOB market', { status: 500 });
    }
    const clobMarket = await clobRes.json() as { tokens?: PmToken[] };
    const tokens = clobMarket.tokens || [];
    const yes = tokens.find((t) => t.outcome.toLowerCase() === 'yes');
    const no = tokens.find((t) => t.outcome.toLowerCase() === 'no');
    if (!yes || !no) {
      return new Response('Polymarket market missing Yes or No token', { status: 400 });
    }
    pmYesTokenId = yes.token_id;
    pmNoTokenId = no.token_id;
  } catch (err) {
    logger.error('[live-scan] failed to resolve polymarket tokens', { err, pmUrl });
    return new Response('Failed to resolve Polymarket market', { status: 500 });
  }

  const session: LiveScanSession = {
    pmYesTokenId,
    pmNoTokenId,
    kalshiTicker,
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

      // Seed books from REST so UI shows prices immediately, then WS deltas keep them fresh.
      seedKalshiBook(kalshiTicker).catch(() => {});
      seedPmBook(pmYesTokenId).catch(() => {});
      seedPmBook(pmNoTokenId).catch(() => {});
      maybeSendResult();

      // ── Kalshi WS ──
      const kalshiSubKey = `live-scan-${kalshiTicker}-${Date.now()}`;
      kalshiWs.connect();
      kalshiWs.subscribe(
        kalshiTicker,
        (msg) => {
          if (session.closed) return;
          if (msg.type === 'orderbook_snapshot') {
            orderbookState.setBook(kalshiTicker, msg.yes, msg.no, msg.seq);
          } else if (msg.type === 'orderbook_delta') {
            orderbookState.applyAskDelta(kalshiTicker, msg.side, msg.price, msg.delta, msg.seq);
          }
          maybeSendResult();
        },
        kalshiSubKey,
      );

      // ── Polymarket WS ──
      const pmSubKey = `live-scan-${pmConditionId}-${Date.now()}`;
      clobWs.connect();
      clobWs.subscribe([pmYesTokenId, pmNoTokenId], (updates) => {
        if (session.closed) return;
        for (const u of updates) {
          if (u.type === 'book' && u.book) {
            applyPolymarketBook(u.tokenId, u.book.asks.map((a) => ({ price: String(a.price), size: String(a.size) })));
          } else if (u.bestAsk != null) {
            orderbookState.setBook(u.tokenId, [{ price: u.bestAsk, quantity: Infinity }], [], u.ts);
          }
        }
        maybeSendResult();
      }, pmSubKey);


      function maybeSendResult() {
        const now = Date.now();
        if (now - lastSend < minIntervalMs) return;
        lastSend = now;
        const result = computeLiveArbitrage({
          kalshiTicker: session.kalshiTicker,
          pmYesTokenId: session.pmYesTokenId,
          pmNoTokenId: session.pmNoTokenId,
          capital: session.capital,
          category: session.category,
        });
        send({ type: 'result', result });
      }

      // Periodic heartbeat even if no updates
      const heartbeat = setInterval(() => {
        if (session.closed) return;
        maybeSendResult();
      }, 1000);

      // Cleanup when client disconnects
      req.signal.addEventListener('abort', () => {
        session.closed = true;
        clearInterval(heartbeat);
        kalshiWs.unsubscribe(kalshiSubKey);
        clobWs.unsubscribe(pmSubKey);
        orderbookState.removeBook(kalshiTicker);
        orderbookState.removeBook(pmYesTokenId);
        orderbookState.removeBook(pmNoTokenId);
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
    const data = await res.json() as { orderbook?: { yes_dollars_fp?: [string, string][]; no_dollars_fp?: [string, string][] } };
    const yes = (data.orderbook?.yes_dollars_fp || [])
      .map(([p, q]) => ({ price: parseFloat(p), quantity: parseFloat(q) }))
      .filter((lvl) => lvl.quantity > 0);
    const no = (data.orderbook?.no_dollars_fp || [])
      .map(([p, q]) => ({ price: parseFloat(p), quantity: parseFloat(q) }))
      .filter((lvl) => lvl.quantity > 0);
    orderbookState.setBook(ticker, yes, no);
  } catch (err) {
    logger.warn('[live-scan] failed to seed Kalshi book', { ticker, err });
  }
}
