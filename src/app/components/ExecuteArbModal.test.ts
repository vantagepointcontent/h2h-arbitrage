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
  kalshiYesAskShares: 100,
  kalshiNoAskShares: 100,
  pmYesAskShares: 100,
  pmNoAskShares: 100,
  stale: false,
  kalshiTicker: 'KXEXAMPLE',
  pmYesTokenId: 'pm-yes',
  pmNoTokenId: 'pm-no',
};

describe('buildExecutableArb', () => {
  it('caps both legs to the same whole share count from their effective live levels', () => {
    const arb = buildExecutableArb({
      ...baseArb,
      kalshiStake: 50,
      pmStake: 70,
      kalshiYesAsk: 0.5,
      pmNoAsk: 0.7,
      kalshiYesAskShares: 40,
      pmNoAskShares: 25,
    }, 'Example market');

    expect(arb?.shares).toBe(25);
    expect(arb?.kalshiOrder).toMatchObject({ outcome: 'yes', price: 0.5, size: 12.5 });
    expect(arb?.polymarketOrder).toMatchObject({ outcome: 'no', price: 0.7, size: 17.5 });
  });

  it('uses the floor-eligible Kalshi quote rather than a lower synthetic ask', () => {
    const arb = buildExecutableArb({
      ...baseArb,
      kalshiYesAsk: 0.43,
      kalshiYesAskShares: 8,
      pmNoAsk: 0.56,
      pmNoAskShares: 8,
      kalshiStake: 100,
      pmStake: 100,
    }, 'Example market');

    expect(arb?.kalshiOrder.price).toBe(0.43);
    expect(arb?.shares).toBe(8);
    expect(arb?.kalshiOrder.size).toBeCloseTo(3.44);
  });

  it('refuses missing, zero, or stale live orderbook data', () => {
    expect(buildExecutableArb({ ...baseArb, kalshiYesAskShares: 0 }, 'Example market')).toBeNull();
    expect(buildExecutableArb({ ...baseArb, pmNoAskShares: undefined }, 'Example market')).toBeNull();
    expect(buildExecutableArb({ ...baseArb, stale: true }, 'Example market')).toBeNull();
    expect(buildExecutableArb({ ...baseArb, kalshiYesAsk: 0 }, 'Example market')).toBeNull();
  });
});
