/**
 * Adaptive refresh rate calculator.
 * Determines how frequently each market should be refreshed based on its expiry date.
 *
 * Tiers (configurable via admin dashboard):
 *   <1 hour  → 15s   (fast — near-expiry markets need tight monitoring)
 *   1-6 hrs  → 60s   (moderate)
 *   6-24 hrs → 5min  (normal)
 *   >24 hrs  → 15min (slow — far-future markets change slowly)
 *
 * All intervals are multiplied by a global multiplier (default 1.0).
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface AdaptiveRefreshTier {
  /** Human-readable label (e.g. "<1h", "1-6h", "6-24h", ">24h") */
  label: string;
  /** Upper bound of the tier in seconds (Infinity for the last tier) */
  maxSeconds: number;
  /** Default refresh interval in seconds */
  defaultIntervalSec: number;
}

export interface AdaptiveRefreshConfig {
  /** Whether adaptive refresh is enabled globally */
  enabled: boolean;
  /** Tier definitions (ordered by maxSeconds ascending) */
  tiers: AdaptiveRefreshTier[];
  /** Global multiplier applied to all computed intervals */
  globalMultiplier: number;
}

export interface AdaptiveRefreshResult {
  /** Computed refresh interval in milliseconds */
  intervalMs: number;
  /** Which tier this market falls into */
  tierLabel: string;
  /** Seconds until market expiry (negative if expired) */
  secondsToExpiry: number;
  /** Whether the market has already expired */
  expired: boolean;
  /** Whether the market lacks an expiry date */
  missingExpiry: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────────

export const DEFAULT_TIERS: readonly AdaptiveRefreshTier[] = [
  { label: '<1h',  maxSeconds: 3600,      defaultIntervalSec: 15 },
  { label: '1-6h', maxSeconds: 21600,     defaultIntervalSec: 60 },
  { label: '6-24h', maxSeconds: 86400,    defaultIntervalSec: 300 },
  { label: '>24h', maxSeconds: Infinity,  defaultIntervalSec: 900 },
];

export const DEFAULT_CONFIG: Readonly<AdaptiveRefreshConfig> = Object.freeze({
  enabled: true,
  tiers: [...DEFAULT_TIERS],
  globalMultiplier: 1,
});

// Default interval when expiryDate is absent — use middle tier
const FALLBACK_INTERVAL_SEC = DEFAULT_TIERS[2].defaultIntervalSec; // 5 min

// ── Core functions ───────────────────────────────────────────────────────

/**
 * Compute the adaptive refresh interval for a market given its expiry date.
 *
 * @param expiryDateISO — ISO 8601 expiry timestamp (UTC or local)
 * @param config — adaptive refresh configuration (defaults to DEFAULT_CONFIG)
 * @returns structured result with interval, tier, and expiry info
 */
export function computeAdaptiveRefresh(
  expiryDateISO: string | null | undefined,
  config: AdaptiveRefreshConfig = DEFAULT_CONFIG,
): AdaptiveRefreshResult {
  if (!expiryDateISO) {
    return {
      intervalMs: FALLBACK_INTERVAL_SEC * 1000 * config.globalMultiplier,
      tierLabel: 'unknown',
      secondsToExpiry: Infinity,
      expired: false,
      missingExpiry: true,
    };
  }

  const now = Date.now();
  const expiryMs = new Date(expiryDateISO).getTime();
  if (isNaN(expiryMs)) {
    // Malformed date — treat as missing
    return {
      intervalMs: FALLBACK_INTERVAL_SEC * 1000 * config.globalMultiplier,
      tierLabel: 'unknown',
      secondsToExpiry: Infinity,
      expired: false,
      missingExpiry: true,
    };
  }

  const secondsToExpiry = Math.round((expiryMs - now) / 1000);
  const expired = secondsToExpiry <= 0;

  // Expired markets use the fastest tier
  if (expired) {
    const tier = config.tiers[0];
    return {
      intervalMs: tier.defaultIntervalSec * 1000 * config.globalMultiplier,
      tierLabel: tier.label,
      secondsToExpiry,
      expired,
      missingExpiry: false,
    };
  }

  // Find the matching tier
  const sec = secondsToExpiry;
  const tiers = config.tiers;
  for (let i = 0; i < tiers.length; i++) {
    if (sec <= tiers[i].maxSeconds) {
      return {
        intervalMs: tiers[i].defaultIntervalSec * 1000 * config.globalMultiplier,
        tierLabel: tiers[i].label,
        secondsToExpiry: sec,
        expired: false,
        missingExpiry: false,
      };
    }
  }

  // Should not reach here if last tier has maxSeconds === Infinity,
  // but fall back safely.
  const lastTier = tiers[tiers.length - 1];
  return {
    intervalMs: lastTier.defaultIntervalSec * 1000 * config.globalMultiplier,
    tierLabel: lastTier.label,
    secondsToExpiry: sec,
    expired: false,
    missingExpiry: false,
  };
}

/**
 * Check whether a market is due for refresh.
 *
 * @param lastScannedAt — ISO timestamp of the last successful scan (from lastScanResult.scannedAt)
 * @param expiryDateISO — market expiry date
 * @param config — adaptive refresh config
 * @returns true if the market should be refreshed now
 */
export function isDueForRefresh(
  lastScannedAt: string | null | undefined,
  expiryDateISO: string | null | undefined,
  config: AdaptiveRefreshConfig = DEFAULT_CONFIG,
): boolean {
  if (!lastScannedAt) return true;

  const { intervalMs } = computeAdaptiveRefresh(expiryDateISO, config);
  const elapsed = Date.now() - new Date(lastScannedAt).getTime();
  return elapsed >= intervalMs;
}

/**
 * Format a refresh interval (milliseconds) into a human-readable string.
 * e.g. 15000 → "15s", 300000 → "5m", 1800000 → "30m"
 */
export function formatInterval(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.round(min)}m`;
  return `${Math.round(min / 60)}h ${Math.round(min % 60)}m`;
}

/**
 * Format seconds-to-expiry into a readable countdown string.
 * e.g. 3661 → "1h 1m", 45 → "45s", 90060 → "1d 1h"
 */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const days = Math.floor(seconds / 86400);
  const remainder = seconds % 86400;
  const hours = Math.floor(remainder / 3600);
  const mins = Math.floor((remainder % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}

/**
 * Calculate the next refresh timestamp for a market.
 * Given the last scan time and the computed interval, returns the
 * ISO string of when the next refresh should occur.
 */
export function nextRefreshAt(
  lastScannedAt: string | null,
  expiryDateISO: string | null,
  config: AdaptiveRefreshConfig = DEFAULT_CONFIG,
): string {
  const { intervalMs } = computeAdaptiveRefresh(expiryDateISO, config);
  const base = lastScannedAt ? new Date(lastScannedAt).getTime() : Date.now();
  return new Date(base + intervalMs).toISOString();
}
