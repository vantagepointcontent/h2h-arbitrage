import { describe, expect, it } from 'vitest';
import { calculateScanApy } from './scan-apy';

describe('calculateScanApy', () => {
  const scan = '2026-08-12T12:00:00.000Z';

  it.each([
    { roiPct: 10, expiry: '2027-08-12T12:00:00.000Z', expected: 10 },
    { roiPct: 10, expiry: '2026-09-11T12:00:00.000Z', expected: (1.1 ** (365 / 30) - 1) * 100 },
    { roiPct: 2.5, expiry: '2026-08-13T00:00:00.000Z', expected: (1.025 ** (365 / 0.5) - 1) * 100 },
    { roiPct: -25, expiry: '2027-08-12T12:00:00.000Z', expected: -25 },
  ])('compounds $roiPct% ROI over the precise fractional TTE as a percentage', ({ roiPct, expiry, expected }) => {
    const result = calculateScanApy(roiPct, scan, expiry);
    expect((result.apyPct ?? 0) / expected).toBeCloseTo(1, 12);
    expect(result.daysToExpiry).toBe((Date.parse(expiry) - Date.parse(scan)) / 86_400_000);
    expect(result.unavailableReason).toBeNull();
  });

  it.each([
    { roiPct: null as unknown as number, scannedAt: scan, expiry: '2026-08-13T12:00:00.000Z', reason: 'invalid_roi' },
    { roiPct: undefined as unknown as number, scannedAt: scan, expiry: '2026-08-13T12:00:00.000Z', reason: 'invalid_roi' },
    { roiPct: 5, scannedAt: scan, expiry: null, reason: 'missing_expiry' },
    { roiPct: 5, scannedAt: scan, expiry: 'not-a-date', reason: 'invalid_expiry' },
    { roiPct: 5, scannedAt: 'not-a-date', expiry: '2026-08-13T12:00:00.000Z', reason: 'invalid_scan_timestamp' },
    { roiPct: 5, scannedAt: scan, expiry: scan, reason: 'non_positive_tte' },
    { roiPct: 5, scannedAt: scan, expiry: '2026-08-11T12:00:00.000Z', reason: 'non_positive_tte' },
    { roiPct: Number.NaN, scannedAt: scan, expiry: '2026-08-13T12:00:00.000Z', reason: 'invalid_roi' },
    { roiPct: -100, scannedAt: scan, expiry: '2026-08-13T12:00:00.000Z', reason: 'invalid_roi' },
    { roiPct: -101, scannedAt: scan, expiry: '2026-08-13T12:00:00.000Z', reason: 'invalid_roi' },
  ])('returns explicit $reason instead of a fabricated APY', ({ roiPct, scannedAt, expiry, reason }) => {
    const result = calculateScanApy(roiPct, scannedAt, expiry);
    expect(result.apyPct).toBeNull();
    expect(result.unavailableReason).toBe(reason);
    expect(Number.isFinite(result.apyPct as number)).toBe(false);
  });

  it('keeps a valid zero ROI as a real 0% APY', () => {
    expect(calculateScanApy(0, scan, '2026-08-13T12:00:00.000Z')).toEqual({
      apyPct: 0,
      daysToExpiry: 1,
      unavailableReason: null,
    });
  });

  it('never emits Infinity for a very short positive TTE', () => {
    const result = calculateScanApy(99, scan, '2026-08-12T12:00:00.001Z');
    expect(result.unavailableReason).toBeNull();
    expect(Number.isFinite(result.apyPct)).toBe(true);
    expect(result.apyPct).toBeGreaterThan(0);
  });
});
