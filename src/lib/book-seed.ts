// REST orderbook seeding — shared by /api/ws/live-scan and the WS watcher daemon (WS-102).
// Seeds orderbookState from Kalshi + Polymarket REST so books exist immediately,
// before WS deltas start flowing.

import { orderbookState } from './orderbook-state';
import { applyPolymarketBook } from './live-arb-engine';
import { makeKalshiAuthHeaders } from './kalshi-auth';
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
    logger.warn('[book-seed] failed to seed Kalshi book', { ticker, err });
  }
}
