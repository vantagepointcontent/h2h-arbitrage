export type ScanApyUnavailableReason =
  | 'invalid_roi'
  | 'invalid_scan_timestamp'
  | 'missing_expiry'
  | 'invalid_expiry'
  | 'non_positive_tte';

export interface ScanApySnapshot {
  apyPct: number | null;
  daysToExpiry: number | null;
  unavailableReason: ScanApyUnavailableReason | null;
}

const MS_PER_DAY = 86_400_000;
const MAX_APY_EXPONENT = Math.log(Number.MAX_VALUE / 100);

/** Compound an event-time ROI over a positive fractional day count. */
export function calculateApyPctFromDays(roiPct: number, daysToExpiry: number): number | null {
  if (!Number.isFinite(roiPct) || roiPct <= -100 || !Number.isFinite(daysToExpiry) || daysToExpiry <= 0) return null;
  if (roiPct === 0) return 0;
  const exponent = Math.log1p(roiPct / 100) * (365 / daysToExpiry);
  if (exponent >= MAX_APY_EXPONENT) return Number.MAX_VALUE;
  return Math.expm1(exponent) * 100;
}

/**
 * Canonical compounded annualization evaluated at the scan timestamp.
 * The result is a percentage, not a multiplier.
 */
export function calculateScanApy(
  roiPct: number,
  scannedAt: string,
  expiryAt: string | null | undefined,
): ScanApySnapshot {
  if (typeof roiPct !== 'number' || !Number.isFinite(roiPct) || roiPct <= -100) {
    return { apyPct: null, daysToExpiry: null, unavailableReason: 'invalid_roi' };
  }

  const scannedAtMs = Date.parse(scannedAt);
  if (!Number.isFinite(scannedAtMs)) {
    return { apyPct: null, daysToExpiry: null, unavailableReason: 'invalid_scan_timestamp' };
  }
  if (!expiryAt) {
    return { apyPct: null, daysToExpiry: null, unavailableReason: 'missing_expiry' };
  }

  const expiryAtMs = Date.parse(expiryAt);
  if (!Number.isFinite(expiryAtMs)) {
    return { apyPct: null, daysToExpiry: null, unavailableReason: 'invalid_expiry' };
  }

  const daysToExpiry = (expiryAtMs - scannedAtMs) / MS_PER_DAY;
  if (daysToExpiry <= 0) {
    return { apyPct: null, daysToExpiry, unavailableReason: 'non_positive_tte' };
  }

  return {
    apyPct: calculateApyPctFromDays(roiPct, daysToExpiry),
    daysToExpiry,
    unavailableReason: null,
  };
}
