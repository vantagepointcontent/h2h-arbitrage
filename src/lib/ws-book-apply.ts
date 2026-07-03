// WS message → orderbookState application logic — shared by /api/ws/live-scan
// and the WS watcher daemon (WS-102).

import { orderbookState } from './orderbook-state';
import { applyPolymarketBook } from './live-arb-engine';
import { KalshiWsMessage } from './kalshi-ws';
import { WsPriceUpdate } from './clob-ws';

/**
 * Apply a Kalshi WS message (snapshot or delta) to orderbookState.
 * Kalshi WS returns BIDS: msg.yes = YES bids, msg.no = NO bids.
 * orderbookState stores ASKS, so bids are converted:
 *   YES asks from NO bids (price 1-P), NO asks from YES bids.
 * WS snapshots only apply when no REST-seeded book exists (REST seed is
 * the authoritative base; WS snapshots can be stale/wrong).
 * Returns true if the book was modified.
 */
export function applyKalshiWsMessage(msg: KalshiWsMessage): boolean {
  if (msg.type === 'orderbook_snapshot') {
    if (orderbookState.hasBook(msg.marketTicker)) return false;
    const yesAsks = msg.no
      .map((b) => ({ price: 1 - b.price, quantity: b.quantity }))
      .filter((a) => a.price > 0 && a.price < 1);
    const noAsks = msg.yes
      .map((b) => ({ price: 1 - b.price, quantity: b.quantity }))
      .filter((a) => a.price > 0 && a.price < 1);
    orderbookState.setBook(msg.marketTicker, yesAsks, noAsks, msg.seq);
    return true;
  }
  if (msg.type === 'orderbook_delta') {
    // side='yes' means a YES BID level changed. We store asks, so a YES bid
    // delta at price P becomes a NO ask delta at (1-P), and vice versa.
    const askSide = msg.side === 'yes' ? 'no' : 'yes';
    const askPrice = 1 - msg.price;
    if (askPrice > 0 && askPrice < 1) {
      orderbookState.applyAskDelta(msg.marketTicker, askSide, askPrice, msg.delta, msg.seq);
      return true;
    }
  }
  return false;
}

/**
 * Apply a batch of Polymarket WS price updates to orderbookState.
 * 'book' messages replace the token's side with the full orderbook; top-of-book
 * updates (best_bid_ask/price_change) adjust the top level without destroying
 * the REST-seeded depth. Returns true if any book was modified.
 */
export function applyPmWsUpdates(updates: WsPriceUpdate[], pmTokenSides: Map<string, 'yes' | 'no'>): boolean {
  let changed = false;
  for (const u of updates) {
    const side = pmTokenSides.get(u.tokenId) ?? 'yes';
    if (u.type === 'book' && u.book) {
      applyPolymarketBook(u.tokenId, u.book.asks.map((a) => ({ price: String(a.price), size: String(a.size) })), side);
      changed = true;
    } else if (u.bestAsk != null && u.bestAsk > 0) {
      const existing = orderbookState.getBook(u.tokenId);
      if (existing) {
        const asks = side === 'yes' ? existing.yes.asks : existing.no.asks;
        const newAsks = asks.filter((a) => a.price < u.bestAsk! - 1e-9);
        newAsks.unshift({ price: u.bestAsk!, quantity: Infinity });
        if (side === 'yes') {
          orderbookState.setBook(u.tokenId, newAsks, existing.no.asks, u.ts);
        } else {
          orderbookState.setBook(u.tokenId, existing.yes.asks, newAsks, u.ts);
        }
      } else {
        if (side === 'yes') {
          orderbookState.setBook(u.tokenId, [{ price: u.bestAsk, quantity: Infinity }], [], u.ts);
        } else {
          orderbookState.setBook(u.tokenId, [], [{ price: u.bestAsk, quantity: Infinity }], u.ts);
        }
      }
      changed = true;
    }
  }
  return changed;
}
