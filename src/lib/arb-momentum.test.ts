import { describe, expect, it } from 'vitest';
import { calculateArbMomentum } from './arb-momentum';

const points = (rois: number[]) => rois.map((roiPct, index) => ({
  roiPct,
  seenAt: new Date(Date.UTC(2026, 6, 27, 12, index * 15)).toISOString(),
}));

describe('calculateArbMomentum', () => {
  it('marks a materially improving net ROI as widening and reports its window', () => {
    const result = calculateArbMomentum(points([1, 1.1, 1.4]));
    expect(result.direction).toBe('widening');
    expect(result.deltaPct).toBeCloseTo(0.4);
    expect(result.windowSeconds).toBe(1800);
    expect(result.sampleCount).toBe(3);
  });

  it('marks a materially shrinking net ROI as narrowing', () => {
    const result = calculateArbMomentum(points([2, 1.8, 1.6]));
    expect(result.direction).toBe('narrowing');
    expect(result.deltaPct).toBeCloseTo(-0.4);
  });

  it('keeps insignificant movement and insufficient history stable', () => {
    expect(calculateArbMomentum(points([1, 1.05, 1.08])).direction).toBe('stable');
    expect(calculateArbMomentum(points([1]))).toEqual({ direction: 'stable', deltaPct: 0, windowSeconds: 0, sampleCount: 1 });
  });

  it('uses only the configured recent window', () => {
    const result = calculateArbMomentum(points([10, 1, 1.2, 1.4]), 3);
    expect(result.direction).toBe('widening');
    expect(result.deltaPct).toBeCloseTo(0.4);
    expect(result.sampleCount).toBe(3);
  });
});
