import { afterEach, describe, expect, it } from 'vitest';
import { applyPolymarketBook, computeAllLiveArbitrages } from './live-arb-engine';
import { orderbookState } from './orderbook-state';

const outcome = {
  artist: 'Example',
  kalshiTicker: 'KX-BUG-096',
  pmYesTokenId: 'pm-yes-bug-096',
  pmNoTokenId: 'pm-no-bug-096',
};

const complement = {
  artist: 'Complement',
  kalshiTicker: 'KX-BUG-101-COMP',
  pmYesTokenId: 'pm-yes-bug-101-comp',
  pmNoTokenId: 'pm-no-bug-101-comp',
};

afterEach(() => {
  orderbookState.removeBook(outcome.kalshiTicker);
  orderbookState.removeBook(outcome.pmYesTokenId);
  orderbookState.removeBook(outcome.pmNoTokenId);
  orderbookState.removeBook(complement.kalshiTicker);
  orderbookState.removeBook(complement.pmYesTokenId);
  orderbookState.removeBook(complement.pmNoTokenId);
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

  it('does not turn a zero-depth live quote into a direct executable stake', () => {
    orderbookState.setBook(outcome.kalshiTicker, [{ price: 0.30, quantity: 0 }], [{ price: 0.72, quantity: 0 }]);
    orderbookState.setRealAskFloor(outcome.kalshiTicker, 0.30, 0.72);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.30, quantity: 10 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.72, quantity: 10 }]);

    const result = computeAllLiveArbitrages([outcome], 100)[0];

    expect(result.kalshiYesAsk).toBe(0.30); // quote stays visible
    expect(result.kalshiYesDepth).toBe(0);
    expect(result.strategy).toBe('No arb');
    expect(result.kalshiStake + result.pmStake).toBe(0);
  });

  it('blocks cross and same-platform candidates when a required live depth is unknown', () => {
    // Prices make every YES+YES path profitable, but the first Kalshi YES
    // quote has zero verified shares and must prevent any executable action.
    orderbookState.setBook(outcome.kalshiTicker, [{ price: 0.30, quantity: 0 }], [{ price: 0.72, quantity: 0 }]);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.30, quantity: 0 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.72, quantity: 10 }]);
    orderbookState.setBook(complement.kalshiTicker, [{ price: 0.30, quantity: 10 }], [{ price: 0.72, quantity: 10 }]);
    orderbookState.setBook(complement.pmYesTokenId, [{ price: 0.30, quantity: 0 }], []);
    orderbookState.setBook(complement.pmNoTokenId, [], [{ price: 0.72, quantity: 10 }]);

    const result = computeAllLiveArbitrages([outcome, complement], 100);

    expect(result[0].strategy).toBe('No arb');
    expect(result[0].kalshiStake + result[0].pmStake).toBe(0);
    expect(result[0].expectedProfit).toBe(0);
  });

  it('drops malformed and non-finite CLOB ask levels before they reach live orderbook state', () => {
    applyPolymarketBook(outcome.pmYesTokenId, [
      { price: 'Infinity', size: '10' },
      { price: '0.35', size: 'Infinity' },
      { price: '0.36junk', size: '5' },
      { price: '0x0.36', size: '5' },
      { price: '0.37', size: '0x4' },
      { price: '0.37', size: '4' },
    ]);

    expect(orderbookState.getBook(outcome.pmYesTokenId)?.yes.asks).toEqual([
      { price: 0.37, quantity: 4 },
    ]);
  });

  it('rejects non-finite and out-of-range levels at the shared orderbook boundary', () => {
    orderbookState.setBook(outcome.pmYesTokenId, [
      { price: Infinity, quantity: 5 },
      { price: 0.35, quantity: Infinity },
      { price: 1.01, quantity: 5 },
      { price: 0.35, quantity: 5 },
    ], []);

    expect(orderbookState.getBook(outcome.pmYesTokenId)?.yes.asks).toEqual([
      { price: 0.35, quantity: 5 },
    ]);
  });
});
