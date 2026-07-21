import { describe, expect, it } from 'vitest';
import { buildExecutableArb } from './ExecuteArbModal';

const baseArb = {
  artist: 'Example outcome',
  strategy: 'Buy YES Kalshi + NO PM',
  roiPct: 3.2,
  expectedProfit: 4.8,
  kalshiStake: 42,
  pmStake: 58,
  kalshiYesAsk: 0.42,
  kalshiNoAsk: 0.58,
  pmYesAsk: 0.41,
  pmNoAsk: 0.58,
  kalshiTicker: 'KXEXAMPLE',
  pmYesTokenId: 'pm-yes',
  pmNoTokenId: 'pm-no',
};

describe('buildExecutableArb', () => {
  it('retains dollar stakes because the execution engine converts them to venue shares', () => {
    const arb = buildExecutableArb(baseArb, 'Example market');

    expect(arb?.kalshiOrder).toMatchObject({ outcome: 'yes', price: 0.42, size: 42 });
    expect(arb?.polymarketOrder).toMatchObject({ outcome: 'no', price: 0.58, size: 58 });
  });

  it('rejects zero-priced legs instead of producing an infinite share quantity', () => {
    expect(buildExecutableArb({ ...baseArb, kalshiYesAsk: 0 }, 'Example market')).toBeNull();
  });
});
