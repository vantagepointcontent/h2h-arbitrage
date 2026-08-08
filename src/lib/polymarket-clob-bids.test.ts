import { describe, expect, it } from 'vitest';
import { extractClobBidPrices, type ClobBook, type ClobMarket } from './polymarket-clob';

const book = (bids: Array<[string, string]>): ClobBook => ({
  bids: bids.map(([price, size]) => ({ price, size })),
  asks: [],
  min_order_size: '1',
  tick_size: '0.01',
});

const market: ClobMarket = {
  condition_id: '0xabc',
  tokens: [
    { token_id: 'yes-token', outcome: 'Yes' },
    { token_id: 'no-token', outcome: 'No' },
  ],
};

describe('extractClobBidPrices', () => {
  it('uses the maximum executable bid from unsorted YES and NO token books', () => {
    expect(extractClobBidPrices(market, book([['0.20', '3'], ['0.47', '2'], ['0.31', '4']]), book([['0.52', '1'], ['0.44', '2']]))).toEqual({
      yesBidCents: 47,
      noBidCents: 52,
      resolved: false,
    });
  });

  it('never uses token metadata midpoint as an executable bid', () => {
    expect(extractClobBidPrices({
      ...market,
      neg_risk: true,
      tokens: [
        { token_id: 'yes-token', outcome: 'Yes', price: 0.61 },
        { token_id: 'no-token', outcome: 'No', price: 0.39 },
      ],
    }, null, null)).toEqual({ yesBidCents: null, noBidCents: null, resolved: false });
  });

  it('uses aggregate complementary quotes only for a standard binary market', () => {
    expect(extractClobBidPrices({ ...market, best_bid: 0.46, best_ask: 0.49, neg_risk: false }, null, null)).toEqual({
      yesBidCents: 46,
      noBidCents: 51,
      resolved: false,
    });
  });

  it('maps resolved token winners to exact 100/0 cent values even when books are empty', () => {
    expect(extractClobBidPrices({
      ...market,
      closed: true,
      tokens: [
        { token_id: 'yes-token', outcome: 'Yes', winner: false },
        { token_id: 'no-token', outcome: 'No', winner: true },
      ],
    }, null, null)).toEqual({ yesBidCents: 0, noBidCents: 100, resolved: true });
  });
});
