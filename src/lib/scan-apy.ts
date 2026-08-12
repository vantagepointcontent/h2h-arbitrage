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

/**
 * Canonical EdgeFinder linear annualization evaluated at the scan timestamp.
 * The result is a percentage, not a multiplier.
 */
export function calculateScanApy(
  roiPct: number,
  scannedAt: string,
  expiryAt: string | null | undefined,
): ScanApySnapshot {
  if (!Number.isFinite(roiPct)) {
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
    apyPct: roiPct <= 0 ? 0 : roiPct * (365 / daysToExpiry),
    daysToExpiry,
    unavailableReason: null,
  };
}
