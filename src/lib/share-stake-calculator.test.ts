import { describe, expect, it } from 'vitest';
import { calculateShareStake, parseAskLevelDepth } from './share-stake-calculator';

describe('calculateShareStake', () => {
  const base = {
    strategy: 'Buy YES Kalshi + NO PM' as const,
    shares: 10,
    kalshiYesAsk: 0.45,
    kalshiNoAsk: 0.56,
    pmYesAsk: 0.52,
    pmNoAsk: 0.5,
    kalshiAvailableShares: 47,
    pmAvailableShares: 12,
    category: 'Politics',
  };

  it('calculates equal-share costs and net profit after both execution fees', () => {
    const result = calculateShareStake(base);

    expect(result).toMatchObject({
      kalshiCost: 4.5,
      pmCost: 5,
      totalCost: 9.5,
      kalshiAvailableShares: 47,
      pmAvailableShares: 12,
      exceedsKalshiDepth: false,
      exceedsPmDepth: false,
    });
    expect(result?.kalshiFee).toBeGreaterThan(0);
    expect(result?.pmFee).toBeGreaterThan(0);
    expect(result?.netProfit).toBeLessThan(0.5); // Fees reduce the apparent $0.50 spread.
    expect(result?.netProfitPct).toBeCloseTo((result!.netProfit / 9.5) * 100, 10);
  });

  it('flags each leg independently when requested shares exceed executable depth', () => {
    const result = calculateShareStake({ ...base, shares: 20 });
    expect(result?.exceedsKalshiDepth).toBe(false);
    expect(result?.exceedsPmDepth).toBe(true);
  });

  it('does not treat dollar liquidity or absent data as executable ask depth', () => {
    expect(parseAskLevelDepth('$100K')).toBeNull();
    expect(parseAskLevelDepth('')).toBeNull();
    expect(parseAskLevelDepth(undefined)).toBeNull();
    expect(parseAskLevelDepth('47')).toBe(47);
    expect(parseAskLevelDepth(0)).toBeNull();
  });
});
