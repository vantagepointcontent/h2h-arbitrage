import { describe, expect, it } from 'vitest';
import { calculateShareStake, parseAskLevelDepth } from './share-stake-calculator';

describe('calculateShareStake', () => {
  const base = {
    strategy: 'Buy YES Kalshi + NO PM' as const,
    shares: 1,
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
      requestedContracts: 1,
      kalshiCost: 0.45,
      pmCost: 0.5,
      totalCost: 0.95,
      kalshiAvailableShares: 47,
      pmAvailableShares: 12,
      exceedsKalshiDepth: false,
      exceedsPmDepth: false,
    });
    expect(result?.kalshiFee).toBeGreaterThan(0);
    expect(result?.pmFee).toBeGreaterThan(0);
    expect(result?.netProfit).toBeLessThan(0.5); // Fees reduce the apparent $0.50 spread.
    expect(result?.netProfitPct).toBeCloseTo((result!.netProfit / 0.95) * 100, 10);
  });

  it('rejects any requested quantity other than the canonical one share', () => {
    expect(calculateShareStake({ ...base, shares: 20 })).toBeNull();
  });

  it('uses the resolved Kalshi authority for interactive sizing', () => {
    const result = calculateShareStake({
      ...base,
      kalshiFeeAuthority: {
        marketTicker: 'K', eventTicker: 'E', seriesTicker: 'S', feeType: 'quadratic',
        feeMultiplierPpm: 0, source: 'event-override', observedAt: '2026-08-08T10:00:00.000Z', version: 'fee-free',
      },
    });
    expect(result?.kalshiFee).toBe(0);
    expect(result?.pmFee).toBeGreaterThan(0);
  });

  it('does not treat dollar liquidity or absent data as executable ask depth', () => {
    expect(parseAskLevelDepth('$100K')).toBeNull();
    expect(parseAskLevelDepth('')).toBeNull();
    expect(parseAskLevelDepth(undefined)).toBeNull();
    expect(parseAskLevelDepth('47')).toBe(47);
    expect(parseAskLevelDepth(0)).toBeNull();
  });
});
