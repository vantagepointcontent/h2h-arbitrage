import { describe, expect, it } from 'vitest';
import { calculateScanApy } from './scan-apy';

describe('calculateScanApy', () => {
  const scan = '2026-08-12T12:00:00.000Z';

  it.each([
    { roiPct: 10, expiry: '2027-08-12T12:00:00.000Z', expected: 10 },
    { roiPct: 10, expiry: '2026-09-11T12:00:00.000Z', expected: 10 * 365 / 30 },
    { roiPct: 2.5, expiry: '2026-08-13T00:00:00.000Z', expected: 2.5 * 365 / 0.5 },
  ])('annualizes $roiPct% ROI over the precise fractional TTE as a percentage', ({ roiPct, expiry, expected }) => {
    const result = calculateScanApy(roiPct, scan, expiry);
    expect(result.apyPct).toBeCloseTo(expected, 10);
    expect(result.daysToExpiry).toBe((Date.parse(expiry) - Date.parse(scan)) / 86_400_000);
    expect(result.unavailableReason).toBeNull();
  });

  it.each([
    { roiPct: 5, scannedAt: scan, expiry: null, reason: 'missing_expiry' },
    { roiPct: 5, scannedAt: scan, expiry: 'not-a-date', reason: 'invalid_expiry' },
    { roiPct: 5, scannedAt: 'not-a-date', expiry: '2026-08-13T12:00:00.000Z', reason: 'invalid_scan_timestamp' },
    { roiPct: 5, scannedAt: scan, expiry: scan, reason: 'non_positive_tte' },
    { roiPct: 5, scannedAt: scan, expiry: '2026-08-11T12:00:00.000Z', reason: 'non_positive_tte' },
    { roiPct: Number.NaN, scannedAt: scan, expiry: '2026-08-13T12:00:00.000Z', reason: 'invalid_roi' },
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
});
