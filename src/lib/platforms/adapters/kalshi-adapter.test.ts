import { describe, expect, it } from 'vitest';
import { KalshiAdapter } from './kalshi-adapter';
import type { KalshiMarket } from '../../kalshi';

describe('KalshiAdapter market normalization', () => {
  it('fails closed for malformed quotes and non-finite optional market metrics', () => {
    const market: KalshiMarket = {
      ticker: 'KXTEST-26JAN01-YES',
      event_ticker: 'KXTEST-26JAN01',
      yes_ask_dollars: '0.42junk',
      no_ask_dollars: 'Infinity',
      yes_bid_dollars: '0x0.4',
      no_bid_dollars: '1.01',
      last_price_dollars: '0.55',
      volume_24h_fp: '12.5junk',
      yes_bid_size_fp: 'Infinity',
      yes_ask_size_fp: '100 contracts',
    };

    const adapter = new KalshiAdapter() as unknown as {
      mapMarket: (input: KalshiMarket) => { outcomes: Array<Record<string, unknown>> };
    };
    const outcome = adapter.mapMarket(market).outcomes[0];

    expect(outcome).toMatchObject({
      yesPrice: 0,
      noPrice: 0,
      bestBid: 0,
      bestAsk: 0,
      lastPrice: 0.55,
      volume24h: undefined,
      bidDepth: undefined,
      askDepth: undefined,
    });
  });
});
