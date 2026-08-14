import { describe, expect, it } from 'vitest';
import { calculateProfitDistribution, resolveDistributionStakes, simplifyContractRatio } from './profit-distribution';

describe('resolveDistributionStakes', () => {
  it('recovers balanced stakes for positive cached arbs that omit per-leg stakes', () => {
    const stakes = resolveDistributionStakes({ expectedProfit: 5, roiPct: 5, kalshiPrice: 0.4, pmPrice: 0.5 });
    expect(stakes?.kalshiStake).toBeCloseTo(44.4444, 3);
    expect(stakes?.pmStake).toBeCloseTo(55.5556, 3);
  });

  it('preserves scanner-provided stakes when available', () => {
    expect(resolveDistributionStakes({ kalshiStake: 42, pmStake: 53, expectedProfit: 5, roiPct: 5, kalshiPrice: 0.42, pmPrice: 0.53 })).toEqual({ kalshiStake: 42, pmStake: 53 });
  });
});

describe('calculateProfitDistribution', () => {
  const input = {
    strategy: 'Buy YES Kalshi + NO PM',
    kalshiPrice: 0.45,
    pmPrice: 0.50,
    kalshiStake: 45,
    pmStake: 50,
    category: 'Politics',
  } as const;

  it('uses exactly one contract on both venues', () => {
    const result = calculateProfitDistribution({ ...input, splitPct: 50 });

    expect(result.requestedContracts).toBe(1);
    expect(result.totalStake).toBeCloseTo(0.95, 8);
    expect(result.kalshiStake).toBeCloseTo(0.45, 8);
    expect(result.pmStake).toBeCloseTo(0.5, 8);
    expect(result.netProfitIfKalshiWins).toBeCloseTo(result.netProfitIfPmWins, 8);
    expect(result.totalFees).toBeGreaterThan(0);
  });

  it('does not let the legacy slider rescale the canonical hedge', () => {
    const center = calculateProfitDistribution({ ...input, splitPct: 50 });
    const right = calculateProfitDistribution({ ...input, splitPct: 100 });

    expect(right.totalStake).toBeCloseTo(center.totalStake, 8);
    expect(right).toMatchObject({ kalshiShares: 1, pmShares: 1 });
    expect(right.kalshiStake).toBe(center.kalshiStake);
    expect(right.pmStake).toBe(center.pmStake);
  });

  it('keeps the same one-share hedge at the opposite slider extreme', () => {
    const center = calculateProfitDistribution({ ...input, splitPct: 50 });
    const left = calculateProfitDistribution({ ...input, splitPct: 0 });

    expect(left.totalStake).toBeCloseTo(center.totalStake, 8);
    expect(left.kalshiStake).toBe(center.kalshiStake);
    expect(left.pmStake).toBe(center.pmStake);
  });

  it('rejects invalid prices rather than producing fabricated payout figures', () => {
    expect(() => calculateProfitDistribution({ ...input, kalshiPrice: 0, splitPct: 50 })).toThrow('valid prices');
  });

  it('reports the canonical 1:1 whole-contract ratio', () => {
    const result = calculateProfitDistribution({
      ...input,
      kalshiPrice: 0.55,
      pmPrice: 0.42,
      kalshiStake: 4.95,
      pmStake: 19.74,
      splitPct: 50,
    });

    expect(result.kalshiShares).toBe(1);
    expect(result.pmShares).toBe(1);
    expect(result.pmToKalshiRatio).toEqual({ pm: 1, kalshi: 1, label: '1:1' });
    expect(result.kalshiOrderCost).toBeCloseTo(0.55, 8);
    expect(result.pmOrderCost).toBeCloseTo(0.42, 8);
  });

  it('reduces a contract ratio by its greatest common divisor', () => {
    expect(simplifyContractRatio(45, 15)).toEqual({ pm: 3, kalshi: 1, label: '3:1' });
    expect(simplifyContractRatio(0, 15)).toBeNull();
  });
});
