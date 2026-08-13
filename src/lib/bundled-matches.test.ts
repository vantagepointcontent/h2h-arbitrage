import { describe, expect, it } from 'vitest';
import {
  allocateBundleBudget,
  normalizeBundleSide,
  validateBundleCoverage,
  type BundleLeg,
} from './bundled-matches';

function leg(overrides: Partial<BundleLeg> & Pick<BundleLeg, 'id' | 'marketId'>): BundleLeg {
  return {
    platform: 'polymarket', title: overrides.marketId, originalSide: 'yes',
    orientation: 'same', priceCents: 25, payoutCents: 100, feeBps: 0,
    quantityStep: 1, minimumQuantity: 1, maximumQuantity: 1000,
    range: { minBps: null, minInclusive: false, maxBps: null, maxInclusive: false },
    ...overrides,
  };
}

describe('bundle coverage', () => {
  const target = { minBps: null, minInclusive: false, maxBps: null, maxInclusive: false };

  it('accepts an exact partition with complementary shared boundaries', () => {
    const result = validateBundleCoverage([
      leg({ id: 'a', marketId: 'under', range: { minBps: null, minInclusive: false, maxBps: 2000, maxInclusive: false } }),
      leg({ id: 'b', marketId: '20-25', range: { minBps: 2000, minInclusive: true, maxBps: 2500, maxInclusive: false } }),
      leg({ id: 'c', marketId: '25+', range: { minBps: 2500, minInclusive: true, maxBps: null, maxInclusive: false } }),
    ], target);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects gaps, overlaps, target-boundary mismatches, and duplicate contracts', () => {
    const gap = validateBundleCoverage([
      leg({ id: 'a', marketId: 'a', range: { minBps: null, minInclusive: false, maxBps: 2000, maxInclusive: false } }),
      leg({ id: 'b', marketId: 'b', range: { minBps: 2000, minInclusive: false, maxBps: null, maxInclusive: false } }),
    ], target);
    expect(gap.valid).toBe(false);
    expect(gap.errors.join(' ')).toMatch(/gap/i);

    const overlap = validateBundleCoverage([
      leg({ id: 'a', marketId: 'a', range: { minBps: null, minInclusive: false, maxBps: 2000, maxInclusive: true } }),
      leg({ id: 'b', marketId: 'b', range: { minBps: 2000, minInclusive: true, maxBps: null, maxInclusive: false } }),
    ], target);
    expect(overlap.errors.join(' ')).toMatch(/overlap/i);

    const duplicate = validateBundleCoverage([
      leg({ id: 'a', marketId: 'same', range: { minBps: null, minInclusive: false, maxBps: 2000, maxInclusive: false } }),
      leg({ id: 'b', marketId: 'same', range: { minBps: 2000, minInclusive: true, maxBps: null, maxInclusive: false } }),
    ], target);
    expect(duplicate.errors.join(' ')).toMatch(/duplicate/i);
  });
});

describe('bundle allocation', () => {
  it('uses integer cents, fees, constraints, and non-equal dollar allocations without exceeding budget', () => {
    const result = allocateBundleBudget([
      leg({ id: 'cheap', marketId: 'cheap', priceCents: 20, feeBps: 100, range: { minBps: null, minInclusive: false, maxBps: 2000, maxInclusive: false } }),
      leg({ id: 'expensive', marketId: 'expensive', priceCents: 45, feeBps: 200, quantityStep: 2, minimumQuantity: 2, range: { minBps: 2000, minInclusive: true, maxBps: null, maxInclusive: false } }),
    ], 10_00);
    expect(result.totalCostCents).toBeLessThanOrEqual(10_00);
    expect(result.allocations.every(a => Number.isSafeInteger(a.costCents) && Number.isSafeInteger(a.feeCents))).toBe(true);
    expect(result.allocations.map(a => a.costCents)[0]).not.toBe(result.allocations.map(a => a.costCents)[1]);
    expect(result.outcomes).toHaveLength(2);
    expect(result.roundingResidualCents).toBe(10_00 - result.totalCostCents);
  });

  it('marks minimum-order, liquidity, and fee-destroyed hedges non-executable with reasons', () => {
    const tooSmall = allocateBundleBudget([
      leg({ id: 'a', marketId: 'a', priceCents: 90, minimumQuantity: 2 }),
      leg({ id: 'b', marketId: 'b', priceCents: 90, minimumQuantity: 2 }),
    ], 100);
    expect(tooSmall.executable).toBe(false);
    expect(tooSmall.reasons.join(' ')).toMatch(/budget|minimum/i);

    const noLiquidity = allocateBundleBudget([
      leg({ id: 'a', marketId: 'a', maximumQuantity: 0 }),
      leg({ id: 'b', marketId: 'b' }),
    ], 1000);
    expect(noLiquidity.reasons.join(' ')).toMatch(/liquidity/i);
  });
});

describe('orientation', () => {
  it('normalizes same and inverted sides exactly once without mutating persisted original side', () => {
    const inverted = leg({ id: 'x', marketId: 'x', originalSide: 'yes', orientation: 'inverted' });
    expect(normalizeBundleSide(inverted)).toBe('no');
    expect(normalizeBundleSide({ ...inverted, orientation: 'same' })).toBe('yes');
    expect(inverted.originalSide).toBe('yes');
  });
});
