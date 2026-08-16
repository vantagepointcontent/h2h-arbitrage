import { describe, expect, it } from 'vitest';
import {
  quoteOneShareFromTopAsk,
  isExecutableQuoteConsistent,
  walkExecutableBook,
  type ExecutableBookFill,
} from './executable-book';
import { orderbookState } from './orderbook-state';

const ONE_SHARE = 1_000_000;
const OBSERVED_AT = '2026-08-14T11:02:35.000Z';

describe('walkExecutableBook', () => {
  it('builds a fixed-point one-share quote from a server-derived top ask and dollar depth', () => {
    expect(quoteOneShareFromTopAsk({
      price: 0.425,
      depthUsd: 0.425,
      tickSize: 0.001,
      minimumOrderSize: 1,
      depthTimestamp: OBSERVED_AT,
    })).toMatchObject({
      status: 'executable',
      requestedQuantityMicros: ONE_SHARE,
      vwapPriceMicroCents: 42_500_000,
      minimumOrderQuantityMicros: ONE_SHARE,
    });
  });

  it('does not claim one-share execution when server-derived top-ask depth is insufficient', () => {
    expect(quoteOneShareFromTopAsk({
      price: 0.5,
      depthUsd: 0.49,
      tickSize: 0.01,
      minimumOrderSize: 1,
      depthTimestamp: OBSERVED_AT,
    }).status).toBe('non_executable');
  });

  it('sorts shuffled asks and fills one share entirely at the minimum ask', () => {
    const quote = walkExecutableBook({
      side: 'buy',
      levels: [
        { priceCents: 47, quantityMicros: 4_000_000 },
        { priceCents: 42, quantityMicros: 2_000_000 },
        { priceCents: 45, quantityMicros: 3_000_000 },
      ],
      requestedQuantityMicros: ONE_SHARE,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: ONE_SHARE,
      depthTimestamp: OBSERVED_AT,
    });

    expect(quote).toMatchObject({
      status: 'executable',
      filledQuantityMicros: ONE_SHARE,
      totalCostMicroCents: 42_000_000,
      vwapPriceMicroCents: 42_000_000,
      depthTimestamp: OBSERVED_AT,
      fills: [{ priceCents: 42, quantityMicros: ONE_SHARE }],
    });
  });

  it('walks only the requested remainder when top ask depth is below one share', () => {
    const quote = walkExecutableBook({
      side: 'buy',
      levels: [
        { priceCents: 45, quantityMicros: 700_000 },
        { priceCents: 40, quantityMicros: 400_000 },
        { priceCents: 50, quantityMicros: 9_000_000 },
      ],
      requestedQuantityMicros: ONE_SHARE,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: ONE_SHARE,
      depthTimestamp: OBSERVED_AT,
    });

    expect(quote).toMatchObject({
      status: 'executable',
      filledQuantityMicros: ONE_SHARE,
      totalCostMicroCents: 43_000_000,
      vwapPriceMicroCents: 43_000_000,
      fills: [
        { priceCents: 40, quantityMicros: 400_000 },
        { priceCents: 45, quantityMicros: 600_000 },
      ],
    });
  });

  it('sorts shuffled bids from maximum to minimum for a sell', () => {
    const quote = walkExecutableBook({
      side: 'sell',
      levels: [
        { priceCents: 55, quantityMicros: 2_000_000 },
        { priceCents: 61, quantityMicros: 2_000_000 },
        { priceCents: 58, quantityMicros: 2_000_000 },
      ],
      requestedQuantityMicros: ONE_SHARE,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: ONE_SHARE,
      depthTimestamp: OBSERVED_AT,
    });

    expect(quote).toMatchObject({
      status: 'executable',
      totalCostMicroCents: 61_000_000,
      fills: [{ priceCents: 61, quantityMicros: ONE_SHARE }],
    });
  });

  it('returns non_executable instead of a partial executable price when cumulative depth is insufficient', () => {
    const quote = walkExecutableBook({
      side: 'buy',
      levels: [
        { priceCents: 40, quantityMicros: 300_000 },
        { priceCents: 45, quantityMicros: 600_000 },
      ],
      requestedQuantityMicros: ONE_SHARE,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: ONE_SHARE,
      depthTimestamp: OBSERVED_AT,
    });

    expect(quote.status).toBe('non_executable');
    expect(quote.reason).toBe('insufficient_depth');
    expect(quote.filledQuantityMicros).toBe(900_000);
    expect(quote.vwapPriceMicroCents).toBeNull();
  });

  it('returns non_executable when the requested quantity is below the venue minimum', () => {
    const quote = walkExecutableBook({
      side: 'buy',
      levels: [{ priceCents: 31, quantityMicros: 100_000_000 }],
      requestedQuantityMicros: ONE_SHARE,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 5_000_000,
      depthTimestamp: OBSERVED_AT,
    });

    expect(quote.status).toBe('non_executable');
    expect(quote.reason).toBe('below_minimum_order');
    expect(quote.fills).toEqual([]);
  });

  it('returns non_executable when a consumed level is not on the declared tick', () => {
    const quote = walkExecutableBook({
      side: 'buy',
      levels: [{ priceCents: 43, quantityMicros: 2_000_000 }],
      requestedQuantityMicros: ONE_SHARE,
      tickSizeCents: 2,
      minimumOrderQuantityMicros: ONE_SHARE,
      depthTimestamp: OBSERVED_AT,
    });

    expect(quote.status).toBe('non_executable');
    expect(quote.reason).toBe('invalid_tick');
    expect(quote.vwapPriceMicroCents).toBeNull();
  });

  it('supports a sub-cent Polymarket tick without floating-point tick math', () => {
    const quote = walkExecutableBook({
      side: 'buy',
      levels: [{ priceMicroCents: 42_500_000, quantityMicros: ONE_SHARE }],
      requestedQuantityMicros: ONE_SHARE,
      tickSizeMicroCents: 100_000,
      minimumOrderQuantityMicros: ONE_SHARE,
      depthTimestamp: OBSERVED_AT,
    });

    expect(quote).toMatchObject({
      status: 'executable',
      vwapPriceMicroCents: 42_500_000,
      limitPriceMicroCents: 42_500_000,
    });
  });

  it.each([
    { levels: [], depthTimestamp: OBSERVED_AT, reason: 'empty_book' },
    { levels: [{ priceCents: 42, quantityMicros: ONE_SHARE }], depthTimestamp: '', reason: 'missing_depth_timestamp' },
    { levels: [{ priceCents: Number.NaN, quantityMicros: ONE_SHARE }], depthTimestamp: OBSERVED_AT, reason: 'malformed_level' },

  ])('returns unavailable for unusable book data: $reason', ({ levels, depthTimestamp, reason }) => {
    const quote = walkExecutableBook({
      side: 'buy',
      levels,
      requestedQuantityMicros: ONE_SHARE,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: ONE_SHARE,
      depthTimestamp,
    });

    expect(quote.status).toBe('unavailable');
    expect(quote.reason).toBe(reason);
    expect(quote.vwapPriceMicroCents).toBeNull();
  });

  it('preserves exact one-share fill invariants across shuffled generated books', () => {
    let seed = 0x5f3759df;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let sample = 0; sample < 500; sample += 1) {
      const levels = Array.from({ length: 5 }, (_, index) => ({
        priceCents: 10 + index * 5,
        quantityMicros: 100_000 + Math.floor(random() * 900_000),
      })).sort(() => random() - 0.5);
      const available = levels.reduce((sum, level) => sum + level.quantityMicros, 0);
      const quote = walkExecutableBook({
        side: 'buy', levels, requestedQuantityMicros: ONE_SHARE,
        tickSizeCents: 1, minimumOrderQuantityMicros: ONE_SHARE,
        depthTimestamp: OBSERVED_AT,
      });

      expect(quote.status).toBe(available >= ONE_SHARE ? 'executable' : 'non_executable');
      expect(quote.filledQuantityMicros).toBe(Math.min(available, ONE_SHARE));
      expect(quote.fills.every((fill: ExecutableBookFill, index: number) => index === 0
        || quote.fills[index - 1].priceCents! <= fill.priceCents!)).toBe(true);
      expect(quote.fills.every((fill: ExecutableBookFill) => fill.quantityMicros > 0)).toBe(true);
    }
  });

  it('rejects a requested quantity whose maximum cent product is not a safe integer', () => {
    const quote = walkExecutableBook({
      side: 'buy',
      levels: [{ priceCents: 99, quantityMicros: Number.MAX_SAFE_INTEGER }],
      requestedQuantityMicros: Number.MAX_SAFE_INTEGER,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: ONE_SHARE,
      depthTimestamp: OBSERVED_AT,
    });

    expect(quote).toMatchObject({ status: 'unavailable', reason: 'invalid_request' });
  });

  it('rejects an internally consistent quote whose fill is off its carried venue tick', () => {
    const forged = walkExecutableBook({
      side: 'buy',
      levels: [{ priceMicroCents: 42_500_000, quantityMicros: ONE_SHARE }],
      requestedQuantityMicros: ONE_SHARE,
      tickSizeMicroCents: 500_000,
      minimumOrderQuantityMicros: ONE_SHARE,
      depthTimestamp: OBSERVED_AT,
    });
    forged.tickSizeMicroCents = 1_000_000;

    expect(isExecutableQuoteConsistent(forged, 'buy', ONE_SHARE)).toBe(false);
  });

  it('rejects a quote whose requested quantity is below its carried venue minimum', () => {
    const forged = walkExecutableBook({
      side: 'buy',
      levels: [{ priceCents: 42, quantityMicros: ONE_SHARE }],
      requestedQuantityMicros: ONE_SHARE,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: ONE_SHARE,
      depthTimestamp: OBSERVED_AT,
    });
    forged.minimumOrderQuantityMicros = 5_000_000;

    expect(isExecutableQuoteConsistent(forged, 'buy', ONE_SHARE)).toBe(false);
  });
});

describe('orderbookState executable quotes', () => {
  it('does not fabricate a depth timestamp for a missing book', () => {
    expect(orderbookState.getExecutableQuote('definitely-missing', 'yes', ONE_SHARE)).toMatchObject({
      status: 'unavailable',
      reason: 'missing_depth_timestamp',
      depthTimestamp: null,
    });
  });

  it('uses the shared walker and preserves venue constraints and depth observation time', () => {
    const id = 'shared-walker-parity';
    orderbookState.setBook(
      id,
      [
        { price: 0.45, quantity: 0.7 },
        { price: 0.40, quantity: 0.4 },
      ],
      [],
      0,
      {
        tickSizeCents: 1,
        minimumOrderQuantityMicros: ONE_SHARE,
        depthTimestamp: OBSERVED_AT,
      },
    );

    expect(orderbookState.getExecutableQuote(id, 'yes', ONE_SHARE)).toMatchObject({
      status: 'executable',
      totalCostMicroCents: 43_000_000,
      vwapPriceMicroCents: 43_000_000,
      depthTimestamp: OBSERVED_AT,
      fills: [
        { priceCents: 40, quantityMicros: 400_000 },
        { priceCents: 45, quantityMicros: 600_000 },
      ],
    });

    orderbookState.removeBook(id);
  });

  it('fails closed when one share is below the book minimum order', () => {
    const id = 'shared-walker-minimum';
    orderbookState.setBook(
      id,
      [{ price: 0.31, quantity: 100 }],
      [],
      0,
      {
        tickSizeCents: 1,
        minimumOrderQuantityMicros: 5_000_000,
        depthTimestamp: OBSERVED_AT,
      },
    );

    expect(orderbookState.getExecutableQuote(id, 'yes', ONE_SHARE)).toMatchObject({
      status: 'non_executable',
      reason: 'below_minimum_order',
      fills: [],
    });

    orderbookState.removeBook(id);
  });
});
