import { describe, expect, it } from 'vitest';
import { buildDepthBook, buildKalshiYesBook, cumulativeLevels } from './market-depth';

describe('market depth normalization', () => {
  it('sorts bids high-to-low and asks low-to-high, discarding invalid levels', () => {
    const book = buildDepthBook(
      [
        { price: '0.42', size: '10' },
        { price: '0.50', size: '20' },
        { price: 'bad', size: '8' },
      ],
      [
        { price: '0.55', size: '5' },
        { price: '0.51', size: '15' },
        { price: '0.90', size: '-1' },
      ],
    );

    expect(book.bids.map(level => level.price)).toEqual([0.5, 0.42]);
    expect(book.asks.map(level => level.price)).toEqual([0.51, 0.55]);
  });

  it('converts Kalshi NO bids into YES asks at the complementary price', () => {
    const book = buildKalshiYesBook(
      [{ price: '0.64', size: '10' }, { price: '0.60', size: '2' }],
      [{ price: '0.35', size: '7' }, { price: '0.30', size: '9' }],
    );

    expect(book.bids).toEqual([{ price: 0.64, size: 10 }, { price: 0.6, size: 2 }]);
    expect(book.asks).toEqual([{ price: 0.65, size: 7 }, { price: 0.7, size: 9 }]);
  });

  it('builds cumulative contract sizes and limits the rendered depth', () => {
    const levels = cumulativeLevels([
      { price: 0.5, size: 20 },
      { price: 0.49, size: 10 },
      { price: 0.48, size: 5 },
    ], 2);

    expect(levels).toEqual([
      { price: 0.5, size: 20, cumulativeSize: 20 },
      { price: 0.49, size: 10, cumulativeSize: 30 },
    ]);
  });
});
