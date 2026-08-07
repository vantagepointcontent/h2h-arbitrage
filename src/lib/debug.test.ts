
import { describe, it, expect, afterEach } from 'vitest';
import { orderbookState } from './orderbook-state';
import { computeAllLiveArbitrages } from './live-arb-engine';

const outcome = { artist: 'Example', kalshiTicker: 'KXTEST', pmYesTokenId: 'PMY', pmNoTokenId: 'PMN' };

describe('debug', () => {
  afterEach(() => {
    orderbookState.removeBook('KXTEST');
    orderbookState.removeBook('PMY');
    orderbookState.removeBook('PMN');
  });
  it('debug fresh arb', () => {
    orderbookState.setBook('KXTEST', [{ price: 0.40, quantity: 100 }], [{ price: 0.60, quantity: 100 }]);
    orderbookState.setBook('PMY', [{ price: 0.42, quantity: 100 }], []);
    orderbookState.setBook('PMN', [], [{ price: 0.58, quantity: 100 }]);
    const r = computeAllLiveArbitrages([outcome], 1000)[0];
    console.log(JSON.stringify({ strategy: r.strategy, roiPct: r.roiPct, expectedProfit: r.expectedProfit, kalshiStake: r.kalshiStake, pmStake: r.pmStake }));
    expect(true).toBe(true);
  });
});
