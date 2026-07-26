// REST orderbook seeding — shared by /api/ws/live-scan and the WS watcher daemon (WS-102).
// Seeds orderbookState from Kalshi + Polymarket REST so books exist immediately,
// before WS deltas start flowing.

import { orderbookState } from './orderbook-state';
import { applyPolymarketBook } from './live-arb-engine';
import { makeKalshiAuthHeaders } from './kalshi-auth';
import { fetchKalshiMarket } from './kalshi';
import logger from './logger';

export async function seedAllBooks(tickers: string[], tokenIds: string[], tokenSides: Map<string, 'yes' | 'no'>): Promise<void> {
  await Promise.all([
    ...tickers.map(seedKalshiBook),
    ...tokenIds.map((tid) => seedPmBook(tid, tokenSides.get(tid) ?? 'yes')),
  ]);
}

export async function seedPmBook(tokenId: string, side: 'yes' | 'no'): Promise<void> {
  try {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    applyPolymarketBook(tokenId, (data.asks || []).map((a: any) => ({ price: String(a.price), size: String(a.size) })), side);
  } catch (err) {
    logger.warn('[book-seed] failed to seed PM book', { tokenId, err });
  }
}

export async function seedKalshiBook(ticker: string): Promise<void> {
  try {
    // ── Fetch the actual ask prices from the markets endpoint ──
    // BUG-06: The Kalshi orderbook endpoint only returns BIDS. We were deriving
    // asks as (1 - opposite_bid), but Kalshi has a bid-ask spread, so
    // 1 - no_bid ≠ yes_ask. This caused the live WS ROI to diverge from the
    // scan API (which uses the actual yes_ask_dollars / no_ask_dollars fields).
    // Fix: also fetch the market data and inject the real best ask as the
    // top-of-book ask level.
    const [orderbookResult, marketResult] = await Promise.allSettled([
      fetch(
        `https://external-api.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`,
        { headers: makeKalshiAuthHeaders('GET', `/trade-api/v2/markets/${ticker}/orderbook`), cache: 'no-store' },
      ).then((res) => res.ok ? res.json() as Promise<any> : null),
      fetchKalshiMarket(ticker),
    ]);

    // Parse orderbook bids → derive asks (same as before, as fallback)
    let yesAsks: { price: number; quantity: number }[] = [];
    let noAsks: { price: number; quantity: number }[] = [];

    if (orderbookResult.status === 'fulfilled' && orderbookResult.value) {
      const data = orderbookResult.value;
      const yesBidLevels = data.orderbook?.yes_dollars_fp ?? data.orderbook?.yes ?? data.orderbook_fp?.yes_dollars ?? [];
      const noBidLevels  = data.orderbook?.no_dollars_fp  ?? data.orderbook?.no  ?? data.orderbook_fp?.no_dollars  ?? [];

      const parseLevels = (raw: [string, string][]) =>
        raw
          .map(([p, q]) => ({ price: parseFloat(p), quantity: parseFloat(q) }))
          .filter((lvl) => !isNaN(lvl.price) && !isNaN(lvl.quantity) && lvl.quantity > 0 && lvl.price > 0 && lvl.price < 1);

      const yesBids = parseLevels(yesBidLevels);
      const noBids  = parseLevels(noBidLevels);

      // Derive YES asks from NO bids: YES ask price = 1 - NO bid price
      yesAsks = noBids
        .map((b) => ({ price: 1 - b.price, quantity: b.quantity }))
        .filter((a) => a.price > 0 && a.price < 1)
        .sort((a, b) => a.price - b.price);

      // Derive NO asks from YES bids: NO ask price = 1 - YES bid price
      noAsks = yesBids
        .map((b) => ({ price: 1 - b.price, quantity: b.quantity }))
        .filter((a) => a.price > 0 && a.price < 1)
        .sort((a, b) => a.price - b.price);
    }

    // ── Inject the REAL best ask from the markets endpoint ──
    // This is the actual ask price that traders pay. We put it at the top
    // of the book with the real ask size, ensuring the weighted-ask calculation
    // uses the correct price. The derived asks from bids serve as deeper
    // levels (fallback when the real ask size is exhausted).
    if (marketResult.status === 'fulfilled' && marketResult.value) {
      const km = marketResult.value;
      const realYesAsk = parseFloat(km.yes_ask_dollars || '0');
      const realNoAsk  = parseFloat(km.no_ask_dollars  || '0');
      const realYesAskSize = parseFloat(km.yes_ask_size_fp || '0');
      const realNoAskSize  = parseFloat(km.no_ask_size_fp  || '0');

      if (realYesAsk > 0 && realYesAsk < 1) {
        // Remove any derived ask levels at a lower price (they're synthetic
        // and cheaper than the real ask — would give false ROI)
        yesAsks = yesAsks.filter((a) => a.price >= realYesAsk - 1e-9);
        // Preserve a quote with an unknown size for display, but never invent
        // executable liquidity. A zero-sized level makes every execution cap
        // fail closed until a live orderbook update supplies real shares.
        yesAsks.unshift({ price: realYesAsk, quantity: realYesAskSize > 0 ? realYesAskSize : 0 });
        yesAsks.sort((a, b) => a.price - b.price);
      }
      if (realNoAsk > 0 && realNoAsk < 1) {
        noAsks = noAsks.filter((a) => a.price >= realNoAsk - 1e-9);
        noAsks.unshift({ price: realNoAsk, quantity: realNoAskSize > 0 ? realNoAskSize : 0 });
        noAsks.sort((a, b) => a.price - b.price);
      }
    }

    if (yesAsks.length > 0 || noAsks.length > 0) {
      orderbookState.setBook(ticker, yesAsks, noAsks);
    }

    // BUG-06: Store the real ask floor so WS deltas that push derived asks
    // below the real ask are filtered out in getWeightedAsk.
    if (marketResult.status === 'fulfilled' && marketResult.value) {
      const km = marketResult.value;
      const realYesAsk = parseFloat(km.yes_ask_dollars || '0');
      const realNoAsk  = parseFloat(km.no_ask_dollars  || '0');
      if (realYesAsk > 0 || realNoAsk > 0) {
        orderbookState.setRealAskFloor(ticker, realYesAsk > 0 ? realYesAsk : undefined, realNoAsk > 0 ? realNoAsk : undefined);
      }
    }
  } catch (err) {
    logger.warn('[book-seed] failed to seed Kalshi book', { ticker, err });
  }
}
