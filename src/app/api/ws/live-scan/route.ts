// Server-Sent Events endpoint for live H2H arbitrage scanning of one market pair.
// Thin wrapper (WS-102): pair resolution, REST seeding, and WS→book application
// live in src/lib (pair-resolver, book-seed, ws-book-apply) and are shared with
// the WS watcher daemon.

import { NextRequest } from 'next/server';
import { clobWs } from '@/lib/clob-ws';
import { kalshiWs, KalshiWsMessage } from '@/lib/kalshi-ws';
import { orderbookState } from '@/lib/orderbook-state';
import { computeAllLiveArbitrages, LiveMatchedOutcome } from '@/lib/live-arb-engine';
import { resolvePair, PairResolveError } from '@/lib/pair-resolver';
import { seedAllBooks } from '@/lib/book-seed';
import { applyKalshiWsMessage, applyPmWsUpdates } from '@/lib/ws-book-apply';
import logger from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Per-request runtime state — isolated by request so closing the SSE shuts everything down.
interface LiveScanSession {
  matchedOutcomes: LiveMatchedOutcome[];
  kalshiTickers: string[];
  pmTokenIds: string[];
  capital: number;
  category?: string;
  closed: boolean;
}

const ERROR_STATUS: Record<string, number> = {
  bad_kalshi_url: 400,
  bad_pm_url: 400,
  kalshi_fetch_failed: 500,
  pm_not_found: 400,
  pm_fetch_failed: 500,
  no_matches: 400,
  no_tokens: 400,
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const kalshiUrl = searchParams.get('kalshiUrl') || '';
  const pmUrl = searchParams.get('pmUrl') || '';
  const capital = Number(searchParams.get('capital') || '10');

  if (!kalshiUrl || !pmUrl) {
    return new Response('Missing kalshiUrl or pmUrl', { status: 400 });
  }

  // ── Resolve the pair (Kalshi tickers + PM token IDs + matched outcomes) ──
  let resolved;
  try {
    resolved = await resolvePair(kalshiUrl, pmUrl, capital);
  } catch (err) {
    if (err instanceof PairResolveError) {
      return new Response(err.message, { status: ERROR_STATUS[err.code] ?? 500 });
    }
    logger.error('[live-scan] unexpected pair resolution failure', { err, kalshiUrl, pmUrl });
    return new Response('Failed to resolve market pair', { status: 500 });
  }

  const { pmTokenSides, category } = resolved;

  const session: LiveScanSession = {
    matchedOutcomes: resolved.matchedOutcomes,
    kalshiTickers: resolved.kalshiTickers,
    pmTokenIds: resolved.pmTokenIds,
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
      seedAllBooks(session.kalshiTickers, session.pmTokenIds, pmTokenSides)
        .then(() => maybeSendResults())
        .catch(() => {});

      // ── Kalshi WS: subscribe to ALL tickers ──
      // B2 fix: record the exact subKeys used at subscribe time so cleanup
      // unsubscribes the same keys.
      const kalshiSubKeys: string[] = [];
      kalshiWs.connect();
      const handleKalshiMsg = (msg: KalshiWsMessage) => {
        if (session.closed) return;
        applyKalshiWsMessage(msg);
        maybeSendResults();
      };

      for (let i = 0; i < session.kalshiTickers.length; i++) {
        const subKey = `live-scan-kalshi-${session.kalshiTickers[i]}-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
        kalshiSubKeys.push(subKey);
        kalshiWs.subscribe(session.kalshiTickers[i], handleKalshiMsg, subKey);
      }

      // ── Polymarket WS: subscribe to ALL token IDs ──
      const pmSubKey = `live-scan-pm-${Date.now()}`;
      clobWs.connect();
      clobWs.subscribe(session.pmTokenIds, (updates) => {
        if (session.closed) return;
        applyPmWsUpdates(updates, pmTokenSides);
        maybeSendResults();
      }, pmSubKey);

      // B5 fix: trailing-edge throttle — if a burst arrives inside the window,
      // schedule one trailing send so the latest state always goes out.
      let trailingTimer: ReturnType<typeof setTimeout> | null = null;
      function doSendResults() {
        lastSend = Date.now();
        const outcomes = computeAllLiveArbitrages(session.matchedOutcomes, session.capital, session.category);
        send({ type: 'result', result: { outcomes, lastUpdate: new Date().toISOString() } });
      }
      function maybeSendResults() {
        const now = Date.now();
        const elapsed = now - lastSend;
        if (elapsed >= minIntervalMs) {
          if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }
          doSendResults();
        } else if (!trailingTimer) {
          trailingTimer = setTimeout(() => {
            trailingTimer = null;
            if (!session.closed) doSendResults();
          }, minIntervalMs - elapsed);
        }
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
        if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }

        // Unsubscribe ALL Kalshi subscriptions using the exact keys from subscribe time (B2)
        for (const key of kalshiSubKeys) {
          kalshiWs.unsubscribe(key);
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
