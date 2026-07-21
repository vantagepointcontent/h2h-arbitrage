import { describe, expect, it } from 'vitest';
import { calculateProfitDistribution } from './profit-distribution';

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
});
