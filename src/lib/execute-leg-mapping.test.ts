import { describe, it, expect } from 'vitest';
import { buildExecutableArb } from '../app/components/ExecuteArbModal';

const base = {
  artist: 'Outcome A',
  roiPct: 2.5,
  expectedProfit: 4.0,
  kalshiStake: 45,
  pmStake: 52,
  kalshiYesAsk: 0.45,
  kalshiNoAsk: 0.57,
  pmYesAsk: 0.41,
  pmNoAsk: 0.52,
  kalshiYesAskShares: 100,
  kalshiNoAskShares: 100,
  pmYesAskShares: 100,
  pmNoAskShares: 100,
  stale: false,
  kalshiTicker: 'KXTEST-26',
  pmYesTokenId: 'tok-yes-1',
  pmNoTokenId: 'tok-no-1',
};

describe('buildExecutableArb leg mapping', () => {
  it('Buy YES Kalshi + NO PM → K yes @ yesAsk, PM no-token @ pmNoAsk', () => {
    const arb = buildExecutableArb({ ...base, strategy: 'Buy YES Kalshi + NO PM' }, 'Test Market');
    expect(arb).not.toBeNull();
    expect(arb!.kalshiOrder.outcome).toBe('yes');
    expect(arb!.kalshiOrder.price).toBe(0.45);
    expect(arb!.kalshiOrder.ticker).toBe('KXTEST-26');
    expect(arb!.polymarketOrder.outcome).toBe('no');
    expect(arb!.polymarketOrder.price).toBe(0.52);
    expect(arb!.polymarketOrder.conditionId).toBe('tok-no-1');
  });

  it('Buy YES PM + NO Kalshi → K no @ noAsk, PM yes-token @ pmYesAsk', () => {
    const arb = buildExecutableArb({ ...base, strategy: 'Buy YES PM + NO Kalshi' }, 'Test Market');
    expect(arb).not.toBeNull();
    expect(arb!.kalshiOrder.outcome).toBe('no');
    expect(arb!.kalshiOrder.price).toBe(0.57);
    expect(arb!.polymarketOrder.outcome).toBe('yes');
    expect(arb!.polymarketOrder.price).toBe(0.41);
    expect(arb!.polymarketOrder.conditionId).toBe('tok-yes-1');
  });

  it('rejects cross-outcome and No-arb strategies', () => {
    expect(buildExecutableArb({ ...base, strategy: 'No arb' }, 'T')).toBeNull();
    expect(buildExecutableArb({ ...base, strategy: 'Buy YES both sides: Kalshi A + PM B' }, 'T')).toBeNull();
  });

  it('rejects rows missing identifiers or prices', () => {
    expect(buildExecutableArb({ ...base, strategy: 'Buy YES Kalshi + NO PM', kalshiTicker: undefined }, 'T')).toBeNull();
    expect(buildExecutableArb({ ...base, strategy: 'Buy YES Kalshi + NO PM', pmNoTokenId: undefined }, 'T')).toBeNull();
    expect(buildExecutableArb({ ...base, strategy: 'Buy YES Kalshi + NO PM', pmNoAsk: null }, 'T')).toBeNull();
    expect(buildExecutableArb({ ...base, strategy: 'Buy YES Kalshi + NO PM', kalshiStake: 0 }, 'T')).toBeNull();
  });

  it('uses the same matched whole-share quantity for both order sizes', () => {
    const arb = buildExecutableArb({ ...base, strategy: 'Buy YES Kalshi + NO PM' }, 'T');
    expect(arb!.shares).toBe(100);
    expect(arb!.kalshiOrder.size).toBe(45);
    expect(arb!.polymarketOrder.size).toBe(52);
  });
});
