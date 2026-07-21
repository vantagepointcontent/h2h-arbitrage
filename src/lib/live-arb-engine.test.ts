import { afterEach, describe, expect, it } from 'vitest';
import { computeAllLiveArbitrages } from './live-arb-engine';
import { orderbookState } from './orderbook-state';

const outcome = {
  artist: 'Example',
  kalshiTicker: 'KX-BUG-096',
  pmYesTokenId: 'pm-yes-bug-096',
  pmNoTokenId: 'pm-no-bug-096',
};

afterEach(() => {
  orderbookState.removeBook(outcome.kalshiTicker);
  orderbookState.removeBook(outcome.pmYesTokenId);
  orderbookState.removeBook(outcome.pmNoTokenId);
});

describe('computeAllLiveArbitrages effective execution quotes', () => {
  it('skips a synthetic Kalshi ask below the REST floor and keeps price/depth paired', () => {
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.20, quantity: 999 }, { price: 0.42, quantity: 7 }],
      [{ price: 0.55, quantity: 10 }],
    );
    orderbookState.setRealAskFloor(outcome.kalshiTicker, 0.42, 0.55);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.44, quantity: 10 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.56, quantity: 5 }]);

    const result = computeAllLiveArbitrages([outcome], 100)[0];

    expect(result.kalshiYesAsk).toBe(0.42);
    expect(result.kalshiYesAskShares).toBe(7);
    expect(result.kalshiYesDepth).toBeCloseTo(2.94);
  });
});
