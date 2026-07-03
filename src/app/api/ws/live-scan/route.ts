import { NextRequest } from 'next/server';
import { clobWs } from '@/lib/clob-ws';
import { kalshiWs, KalshiWsMessage } from '@/lib/kalshi-ws';
import { orderbookState } from '@/lib/orderbook-state';
import { computeAllLiveArbitrages, applyPolymarketBook, LiveMatchedOutcome } from '@/lib/live-arb-engine';
import { makeKalshiAuthHeaders } from '@/lib/kalshi-auth';
import { extractKalshiEventTicker, fetchKalshiEventMarkets, KalshiMarket } from '@/lib/kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl, PMMarket } from '@/lib/polymarket';
import { matchOutcomes, applyManualMatches, UnifiedOutcome } from '@/lib/matcher';
import { getManualMatches } from '@/lib/manual-matches';
import { getDecoupledPairs, applyDecoupledPairs } from '@/lib/decoupled-pairs';
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
  const [manualMatches, decoupledPairs] = await Promise.all([getManualMatches(), getDecoupledPairs()]);
  const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent?.title, capital);
  // Apply manual matches (merges auto-unmatched pairs) then split decoupled pairs — same as /api/scan
  const mergedOutcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, capital, pmEvent?.endDate);
  const finalOutcomes = applyDecoupledPairs(mergedOutcomes as unknown as UnifiedOutcome[], decoupledPairs);

  // Filter to only fully matched outcomes (both Kalshi and PM present)
  const matched = finalOutcomes.filter((o) => o.kalshi && o.polymarket);

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
  // Track which outcome side (yes/no) each PM token_id represents
  const pmTokenSides = new Map<string, 'yes' | 'no'>();

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
    // Track which side each token represents
    pmTokenSides.set(tokens.yes, 'yes');
    pmTokenSides.set(tokens.no, 'no');
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
      seedAllBooks(session.kalshiTickers, session.pmTokenIds, pmTokenSides)
        .then(() => maybeSendResults())
        .catch(() => {});

      // ── Kalshi WS: subscribe to ALL tickers ──
      // B2 fix: record the exact subKeys used at subscribe time so cleanup
      // unsubscribes the same keys (previously extra keys were rebuilt with
      // Date.now() at abort time and never matched — permanent subscriber leak).
      const kalshiSubKeys: string[] = [];
      kalshiWs.connect();
      const handleKalshiMsg = (msg: KalshiWsMessage) => {
        if (session.closed) return;
        if (msg.type === 'orderbook_snapshot') {
          // Only apply WS snapshot if we don't already have a REST-seeded book.
          // REST seed is the authoritative base; WS snapshots can be stale/wrong.
          // Kalshi WS returns BIDS: msg.yes = YES bids, msg.no = NO bids.
          // Convert to asks: YES asks from NO bids, NO asks from YES bids.
          if (!orderbookState.hasBook(msg.marketTicker)) {
            const yesAsks = msg.no
              .map((b) => ({ price: 1 - b.price, quantity: b.quantity }))
              .filter((a) => a.price > 0 && a.price < 1);
            const noAsks = msg.yes
              .map((b) => ({ price: 1 - b.price, quantity: b.quantity }))
              .filter((a) => a.price > 0 && a.price < 1);
            orderbookState.setBook(msg.marketTicker, yesAsks, noAsks, msg.seq);
          }
        } else if (msg.type === 'orderbook_delta') {
          // Kalshi WS delta: side='yes' means a YES BID level changed.
          // We store asks, so a YES bid delta at price P becomes a NO ask delta at (1-P),
          // and a NO bid delta at price P becomes a YES ask delta at (1-P).
          const askSide = msg.side === 'yes' ? 'no' : 'yes';
          const askPrice = 1 - msg.price;
          if (askPrice > 0 && askPrice < 1) {
            orderbookState.applyAskDelta(msg.marketTicker, askSide, askPrice, msg.delta, msg.seq);
          }
        }
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
        for (const u of updates) {
          const side = pmTokenSides.get(u.tokenId) ?? 'yes';
          if (u.type === 'book' && u.book) {
            // Full book snapshot — replace the side with the full orderbook
            applyPolymarketBook(u.tokenId, u.book.asks.map((a) => ({ price: String(a.price), size: String(a.size) })), side);
          } else if (u.bestAsk != null && u.bestAsk > 0) {
            // best_bid_ask or price_change update — update the top of book
            // without destroying the full book that was seeded from REST
            const existing = orderbookState.getBook(u.tokenId);
            if (existing) {
              // Update only the relevant side with the new best ask
              const asks = side === 'yes' ? existing.yes.asks : existing.no.asks;
              // If the best ask changed, replace the top level
              const newAsks = asks.filter((a) => a.price < u.bestAsk! - 1e-9);
              newAsks.unshift({ price: u.bestAsk!, quantity: Infinity });
              if (side === 'yes') {
                orderbookState.setBook(u.tokenId, newAsks, existing.no.asks, u.ts);
              } else {
                orderbookState.setBook(u.tokenId, existing.yes.asks, newAsks, u.ts);
              }
            } else {
              // No existing book — seed with single level
              if (side === 'yes') {
                orderbookState.setBook(u.tokenId, [{ price: u.bestAsk, quantity: Infinity }], [], u.ts);
              } else {
                orderbookState.setBook(u.tokenId, [], [{ price: u.bestAsk, quantity: Infinity }], u.ts);
              }
            }
          }
        }
        maybeSendResults();
      }, pmSubKey);

      // B5 fix: trailing-edge throttle — if a burst arrives inside the window,
      // schedule one trailing send so the latest state always goes out
      // (previously leading-only; the last update in a burst was dropped
      // until the 1s heartbeat).
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

// ── Seeding helpers ──

async function seedAllBooks(tickers: string[], tokenIds: string[], tokenSides: Map<string, 'yes' | 'no'>): Promise<void> {
  await Promise.all([
    ...tickers.map(seedKalshiBook),
    ...tokenIds.map((tid) => seedPmBook(tid, tokenSides.get(tid) ?? 'yes')),
  ]);
}

async function seedPmBook(tokenId: string, side: 'yes' | 'no') {
  try {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    applyPolymarketBook(tokenId, (data.asks || []).map((a: any) => ({ price: String(a.price), size: String(a.size) })), side);
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
      orderbook?: { yes_dollars_fp?: [string, string][]; no_dollars_fp?: [string, string][] } |
                   { yes: [string, string][]; no: [string, string][] };
      orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
    };
    // Kalshi REST orderbook returns BIDS: yes_dollars_fp = YES bid levels, no_dollars_fp = NO bid levels.
    // The orderbook-state stores ASKS. In binary markets:
    //   YES ASK = 1 - best NO BID  (highest NO bid → lowest YES ask)
    //   NO ASK  = 1 - best YES BID (highest YES bid → lowest NO ask)
    // We also handle the alternate format where levels are under .yes/.no (not _dollars_fp).
    const yesBidLevels = (data.orderbook as any)?.yes_dollars_fp ?? (data.orderbook as any)?.yes ?? data.orderbook_fp?.yes_dollars ?? [];
    const noBidLevels  = (data.orderbook as any)?.no_dollars_fp  ?? (data.orderbook as any)?.no  ?? data.orderbook_fp?.no_dollars  ?? [];

    const parseLevels = (raw: [string, string][]) =>
      raw
        .map(([p, q]) => ({ price: parseFloat(p), quantity: parseFloat(q) }))
        .filter((lvl) => !isNaN(lvl.price) && !isNaN(lvl.quantity) && lvl.quantity > 0 && lvl.price > 0 && lvl.price < 1);

    const yesBids = parseLevels(yesBidLevels);
    const noBids  = parseLevels(noBidLevels);

    // Derive YES asks from NO bids: YES ask price = 1 - NO bid price, quantity = NO bid quantity
    const yesAsks = noBids
      .map((b) => ({ price: 1 - b.price, quantity: b.quantity }))
      .filter((a) => a.price > 0 && a.price < 1)
      .sort((a, b) => a.price - b.price); // asks sorted ascending (cheapest first)

    // Derive NO asks from YES bids: NO ask price = 1 - YES bid price, quantity = YES bid quantity
    const noAsks = yesBids
      .map((b) => ({ price: 1 - b.price, quantity: b.quantity }))
      .filter((a) => a.price > 0 && a.price < 1)
      .sort((a, b) => a.price - b.price);

    orderbookState.setBook(ticker, yesAsks, noAsks);
  } catch (err) {
    logger.warn('[live-scan] failed to seed Kalshi book', { ticker, err });
  }
}
