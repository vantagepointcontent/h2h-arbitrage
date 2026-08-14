// Local orderbook state manager for live Kalshi + Polymarket WS streams.
// Maintains full ask depth per outcome and calculates weighted average buy price.

import {
  MICRO_CENTS_PER_CENT,
  MICRO_CENTS_PER_DOLLAR,
  QUANTITY_SCALE,
  walkExecutableBook,
  type ExecutableBookQuote,
} from './executable-book';

export interface OrderbookLevel {
  price: number;
  priceMicroCents?: number;
  quantity: number; // notional/contracts at that price level
}

export interface BookSide {
  asks: OrderbookLevel[]; // sorted lowest -> highest price
}

export interface FullBook {
  yes: BookSide;
  no: BookSide;
  lastUpdate: number;
  seq: number;
  /** BUG-06: Real best ask from Kalshi markets endpoint — derived ask levels
   *  (from opposite bids) below this floor are synthetic and must not be used. */
  realYesAsk?: number;
  realNoAsk?: number;
  /** Integer venue price tick in millionths of one cent. */
  tickSizeMicroCents: number;
  /** Integer millionths of a contract/share. */
  minimumOrderQuantityMicros: number;
  /** Successful book-response observation time, not calculation completion time. */
  depthTimestamp: string;
}

export interface BookExecutionConstraints {
  tickSizeCents?: number;
  tickSizeMicroCents?: number;
  minimumOrderQuantityMicros: number;
  depthTimestamp: string;
}

export interface WeightedAskResult {
  avgPrice: number;
  maxQuantity: number; // how many contracts can be bought
  totalCost: number; // notional cost for maxQuantity
  sufficientDepth: boolean;
}

export type BookIdentifier = string; // token_id for Polymarket, ticker for Kalshi

class OrderbookState {
  private books = new Map<BookIdentifier, FullBook>();

  constructor() {
    // Bounded-memory guard: books not updated for 60 min are dead
    // (unsubscribed or disconnected stream) — evict them (audit F7 fix).
    const BOOK_TTL_MS = 60 * 60_000;
    setInterval(() => {
      const cutoff = Date.now() - BOOK_TTL_MS;
      for (const [id, book] of this.books) {
        if (book.lastUpdate < cutoff) this.books.delete(id);
      }
    }, 10 * 60_000).unref?.();
  }

  getBook(id: BookIdentifier): FullBook | undefined {
    return this.books.get(id);
  }

  hasBook(id: BookIdentifier): boolean {
    return this.books.has(id);
  }

  /** Replace the entire book (used for snapshots). */
  setBook(
    id: BookIdentifier,
    yes: OrderbookLevel[],
    no: OrderbookLevel[],
    seq = 0,
    constraints?: BookExecutionConstraints,
  ): void {
    const existing = this.books.get(id);
    const observedAt = constraints?.depthTimestamp ?? new Date().toISOString();
    this.books.set(id, {
      yes: { asks: this.sortAsks(yes) },
      no: { asks: this.sortAsks(no) },
      lastUpdate: Date.now(),
      seq,
      tickSizeMicroCents: constraints?.tickSizeMicroCents
        ?? (constraints?.tickSizeCents != null ? constraints.tickSizeCents * MICRO_CENTS_PER_CENT : undefined)
        ?? existing?.tickSizeMicroCents
        ?? MICRO_CENTS_PER_CENT,
      minimumOrderQuantityMicros: constraints?.minimumOrderQuantityMicros
        ?? existing?.minimumOrderQuantityMicros
        ?? QUANTITY_SCALE,
      depthTimestamp: observedAt,
      ...(existing?.realYesAsk != null ? { realYesAsk: existing.realYesAsk } : {}),
      ...(existing?.realNoAsk != null ? { realNoAsk: existing.realNoAsk } : {}),
    });
  }

  getExecutableQuote(
    id: BookIdentifier,
    side: 'yes' | 'no',
    requestedQuantityMicros = QUANTITY_SCALE,
  ): ExecutableBookQuote {
    const book = this.books.get(id);
    if (!book) {
      return walkExecutableBook({
        side: 'buy',
        levels: [],
        requestedQuantityMicros,
        tickSizeMicroCents: MICRO_CENTS_PER_CENT,
        minimumOrderQuantityMicros: QUANTITY_SCALE,
        depthTimestamp: null,
      });
    }

    const floor = side === 'yes' ? book.realYesAsk : book.realNoAsk;
    const asks = floor == null
      ? book[side].asks
      : book[side].asks.filter((level) => level.price >= floor - 1e-9);
    const levels = asks.map((level) => {
      const rawPriceMicroCents = level.price * MICRO_CENTS_PER_DOLLAR;
      const rawQuantityMicros = level.quantity * QUANTITY_SCALE;
      const priceMicroCents = level.priceMicroCents ?? Math.round(rawPriceMicroCents);
      const quantityMicros = Math.round(rawQuantityMicros);
      return {
        priceMicroCents: Number.isSafeInteger(priceMicroCents)
          && (level.priceMicroCents != null || Math.abs(rawPriceMicroCents - priceMicroCents) < 1e-6)
          ? priceMicroCents
          : Number.NaN,
        quantityMicros: Number.isSafeInteger(quantityMicros) && Math.abs(rawQuantityMicros - quantityMicros) < 1e-6
          ? quantityMicros
          : Number.NaN,
      };
    });
    return walkExecutableBook({
      side: 'buy',
      levels,
      requestedQuantityMicros,
      tickSizeMicroCents: book.tickSizeMicroCents,
      minimumOrderQuantityMicros: book.minimumOrderQuantityMicros,
      depthTimestamp: book.depthTimestamp,
    });
  }

  /** Apply a delta update for asks (positive = add, negative/empty = remove). */
  applyAskDelta(id: BookIdentifier, side: 'yes' | 'no', price: number, deltaQty: number, seq = 0): void {
    const book = this.books.get(id);
    if (!book) {
      // If we receive a delta before snapshot, seed an empty book.
      this.setBook(id, [], [], seq);
      return this.applyAskDelta(id, side, price, deltaQty, seq);
    }

    const target = book[side].asks;
    const idx = target.findIndex((lvl) => Math.abs(lvl.price - price) < 1e-9);

    if (idx >= 0) {
      target[idx].quantity += deltaQty;
      if (target[idx].quantity <= 1e-9) {
        target.splice(idx, 1);
      }
    } else if (deltaQty > 0) {
      target.push({ price, quantity: deltaQty });
    }

    book[side].asks = this.sortAsks(target);
    book.lastUpdate = Date.now();
    book.depthTimestamp = new Date().toISOString();
    book.seq = seq;
  }

  /**
   * Compute weighted average ask price for a target notional buy amount.
   * @param id book identifier
   * @param targetDollars how many dollars we want to spend
   * @returns avgPrice and how many contracts we can actually buy
   */
  getWeightedAsk(id: BookIdentifier, side: 'yes' | 'no', targetDollars: number): WeightedAskResult {
    const book = this.books.get(id);
    if (!book) {
      return { avgPrice: 0, maxQuantity: 0, totalCost: 0, sufficientDepth: false };
    }

    const asks = book[side].asks;
    if (asks.length === 0) {
      return { avgPrice: 0, maxQuantity: 0, totalCost: 0, sufficientDepth: false };
    }

    // BUG-06: Filter out derived ask levels below the real ask floor.
    // Kalshi WS only streams bids; asks are derived as (1 - opposite_bid).
    // But Kalshi has a spread, so derived asks can be cheaper than the real
    // ask. The real ask floor is set by book-seed from the markets endpoint.
    const floor = side === 'yes' ? book.realYesAsk : book.realNoAsk;
    const effectiveAsks = floor != null
      ? asks.filter((lvl) => lvl.price >= floor - 1e-9)
      : asks;
    if (effectiveAsks.length === 0) {
      return { avgPrice: 0, maxQuantity: 0, totalCost: 0, sufficientDepth: false };
    }

    let remaining = targetDollars;
    let totalCost = 0;
    let totalQty = 0;

    for (const lvl of effectiveAsks) {
      if (remaining <= 1e-9 || lvl.price <= 1e-9) break;

      const maxSpendAtLevel = lvl.quantity * lvl.price;
      const spend = Math.min(remaining, maxSpendAtLevel);
      const qty = spend / lvl.price;

      totalCost += spend;
      totalQty += qty;
      remaining -= spend;
    }

    const sufficientDepth = remaining <= 1e-9;
    const avgPrice = totalQty > 0 ? totalCost / totalQty : 0;

    return {
      avgPrice,
      maxQuantity: totalQty,
      totalCost,
      sufficientDepth,
    };
  }

  /** Set the real best ask floor for a Kalshi book (BUG-06).
   *  Derived ask levels (from opposite bids) below this floor are synthetic
   *  and must not be used — Kalshi has a bid-ask spread, so 1-no_bid < yes_ask.
   *  WS deltas can push derived levels below the real ask; this floor prevents
   *  them from being used in getWeightedAsk. */
  setRealAskFloor(id: BookIdentifier, realYesAsk?: number, realNoAsk?: number): void {
    const book = this.books.get(id);
    if (!book) return;
    if (realYesAsk != null && realYesAsk > 0 && realYesAsk < 1) book.realYesAsk = realYesAsk;
    if (realNoAsk != null && realNoAsk > 0 && realNoAsk < 1) book.realNoAsk = realNoAsk;
  }

  /** Remove a book from memory (when unsubscribing). */
  removeBook(id: BookIdentifier): void {
    this.books.delete(id);
  }

  /**
   * True if the book is missing or hasn't been updated within maxAgeMs.
   * Used to avoid computing arbs against dead/disconnected orderbooks.
   */
  isStale(id: BookIdentifier, maxAgeMs = 30_000): boolean {
    const book = this.books.get(id);
    if (!book) return true;
    return Date.now() - book.lastUpdate > maxAgeMs;
  }

  /** True when the last full size/depth observation is too old for execution. */
  isDepthStale(id: BookIdentifier, maxAgeMs = 30_000): boolean {
    const book = this.books.get(id);
    if (!book) return true;
    const observedAt = Date.parse(book.depthTimestamp);
    return !Number.isFinite(observedAt) || Date.now() - observedAt > maxAgeMs;
  }

  private sortAsks(levels: OrderbookLevel[]): OrderbookLevel[] {
    return levels
      // This is the final boundary before any REST/WS update becomes live
      // execution depth. Individual adapters validate their payloads too, but
      // every caller of setBook()/applyAskDelta() must fail closed here.
      .filter((lvl) =>
        Number.isFinite(lvl.price) &&
        Number.isFinite(lvl.quantity) &&
        lvl.price > 1e-9 &&
        lvl.price < 1 &&
        lvl.quantity > 1e-9,
      )
      .sort((a, b) => a.price - b.price);
  }
}

export const orderbookState = new OrderbookState();
