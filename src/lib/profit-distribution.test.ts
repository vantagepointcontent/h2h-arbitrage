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

  it('keeps the matched balanced stakes and equal scenario profit at 50%', () => {
    const result = calculateProfitDistribution({ ...input, splitPct: 50 });

    expect(result.totalStake).toBeCloseTo(95, 8);
    expect(result.kalshiStake).toBeCloseTo(45, 8);
    expect(result.pmStake).toBeCloseTo(50, 8);
    expect(result.netProfitIfKalshiWins).toBeCloseTo(result.netProfitIfPmWins, 8);
    expect(result.totalFees).toBeGreaterThan(0);
  });

  it('preserves total stake while moving expected payout toward Kalshi at the right extreme', () => {
    const center = calculateProfitDistribution({ ...input, splitPct: 50 });
    const right = calculateProfitDistribution({ ...input, splitPct: 100 });

    expect(right.totalStake).toBeCloseTo(center.totalStake, 8);
    expect(right.kalshiStake).toBeCloseTo(right.totalStake, 8);
    expect(right.pmStake).toBeCloseTo(0, 8);
    expect(right.netProfitIfKalshiWins).toBeGreaterThan(center.netProfitIfKalshiWins);
    expect(right.netProfitIfPmWins).toBeLessThan(center.netProfitIfPmWins);
  });

  it('preserves total stake while moving expected payout toward Polymarket at the left extreme', () => {
    const center = calculateProfitDistribution({ ...input, splitPct: 50 });
    const left = calculateProfitDistribution({ ...input, splitPct: 0 });

    expect(left.totalStake).toBeCloseTo(center.totalStake, 8);
    expect(left.kalshiStake).toBeCloseTo(0, 8);
    expect(left.pmStake).toBeCloseTo(left.totalStake, 8);
    expect(left.netProfitIfPmWins).toBeGreaterThan(center.netProfitIfPmWins);
    expect(left.netProfitIfKalshiWins).toBeLessThan(center.netProfitIfKalshiWins);
  });

  it('rejects invalid prices rather than producing fabricated payout figures', () => {
    expect(() => calculateProfitDistribution({ ...input, kalshiPrice: 0, splitPct: 50 })).toThrow('valid prices');
  });

  it('reports whole buyable shares and the lowest PM:Kalshi contract split', () => {
    const result = calculateProfitDistribution({
      ...input,
      kalshiPrice: 0.55,
      pmPrice: 0.42,
      kalshiStake: 4.95,
      pmStake: 19.74,
      splitPct: 50,
    });

    expect(result.kalshiShares).toBe(9);
    expect(result.pmShares).toBe(47);
    expect(result.pmToKalshiRatio).toEqual({ pm: 47, kalshi: 9, label: '47:9' });
    expect(result.kalshiOrderCost).toBeCloseTo(4.95, 8);
    expect(result.pmOrderCost).toBeCloseTo(19.74, 8);
  });

  it('reduces a contract ratio by its greatest common divisor', () => {
    expect(simplifyContractRatio(45, 15)).toEqual({ pm: 3, kalshi: 1, label: '3:1' });
    expect(simplifyContractRatio(0, 15)).toBeNull();
  });
});
