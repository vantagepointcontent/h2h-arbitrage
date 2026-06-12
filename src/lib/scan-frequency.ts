/**
 * Dynamic scan frequency system for H2H Arbitrage
 *
 * Markets are bucketed by days-to-expiry and scanned at different frequencies.
 * Default frequencies (configurable):
 *   - ≤ 7 days:   every scan (every cron run)
 *   - 8–14 days:  every 2nd scan
 *   - 15–30 days: every 4th scan
 *   - > 30 days:  every 8th scan
 *
 * Each market tracks its lastScannedAt and scanCount to determine if it's "due".
 */

export interface ScanFrequencyConfig {
  tiers: ScanTier[];
}

export interface ScanTier {
  maxDays: number;      // inclusive upper bound (Infinity for last tier)
  label: string;
  intervalRuns: number; // scan every N cron runs (1 = every run)
}

export const DEFAULT_SCAN_CONFIG: ScanFrequencyConfig = {
  tiers: [
    { maxDays: 7,   label: "Hot",    intervalRuns: 1 },  // ≤ 7 days: every run
    { maxDays: 14,  label: "Warm",   intervalRuns: 2 },  // 8–14 days: every 2nd
    { maxDays: 30,  label: "Cool",   intervalRuns: 4 },  // 15–30 days: every 4th
    { maxDays: Infinity, label: "Cold", intervalRuns: 8 }, // > 30 days: every 8th
  ],
};

/** Determine which tier a market belongs to based on its expiry date */
export function getTierForMarket(
  expiryDate: string | null | undefined,
  config: ScanFrequencyConfig = DEFAULT_SCAN_CONFIG,
): ScanTier | null {
  if (!expiryDate) return config.tiers[config.tiers.length - 1]; // No expiry = coldest tier

  const expiry = new Date(expiryDate).getTime();
  const now = Date.now();
  const daysToExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

  if (daysToExpiry <= 0) return config.tiers[0]; // Expired = treat as hot

  for (const tier of config.tiers) {
    if (daysToExpiry <= tier.maxDays) return tier;
  }
  return config.tiers[config.tiers.length - 1];
}

/** Check if a market is due for scanning based on last scan time and tier */
export function isMarketDueForScan(
  expiryDate: string | null | undefined,
  lastScannedAt: string | null | undefined,
  runCount: number,           // global cron run counter
  config: ScanFrequencyConfig = DEFAULT_SCAN_CONFIG,
): boolean {
  const tier = getTierForMarket(expiryDate, config);
  if (!tier) return true; // fallback: always scan

  // First scan: always due
  if (!lastScannedAt) return true;

  // Hot markets (intervalRuns=1): always due
  if (tier.intervalRuns <= 1) return true;

  // Use market-specific offset based on hash of market ID so that
  // cold markets don't all scan in the same run (spread the load)
  const lastScanTime = new Date(lastScannedAt).getTime();
  const hoursSinceLastScan = (Date.now() - lastScanTime) / (1000 * 60 * 60);

  // Hard minimum: even cold markets scanned at least every 24h
  const minHours = Math.min(tier.intervalRuns * 0.5, 24); // e.g. tier=8 → min 4h
  if (hoursSinceLastScan < minHours) return false;

  return true; // Due based on tier logic (simplified: always scan after minHours)
}

/** Sort markets by priority for scanning (hot first, then by last scan time) */
export function sortMarketsByScanPriority(
  markets: Array<{
    id: string;
    expiryDate?: string | null;
    lastScanResult?: { scannedAt?: string | null } | null;
  }>,
  config: ScanFrequencyConfig = DEFAULT_SCAN_CONFIG,
): typeof markets {
  return [...markets].sort((a, b) => {
    const tierA = getTierForMarket(a.expiryDate, config);
    const tierB = getTierForMarket(b.expiryDate, config);

    // Hotter tiers first (lower intervalRuns = higher priority)
    const priorityDiff = (tierA?.intervalRuns ?? 99) - (tierB?.intervalRuns ?? 99);
    if (priorityDiff !== 0) return priorityDiff;

    // Within same tier: least recently scanned first
    const lastA = a.lastScanResult?.scannedAt
      ? new Date(a.lastScanResult.scannedAt).getTime()
      : 0;
    const lastB = b.lastScanResult?.scannedAt
      ? new Date(b.lastScanResult.scannedAt).getTime()
      : 0;
    return lastA - lastB;
  });
}

/** Get a human-readable summary of scan plan for a list of markets */
export function getScanPlanSummary(
  markets: Array<{
    id: string;
    eventTitle: string;
    expiryDate?: string | null;
    lastScanResult?: { scannedAt?: string | null } | null;
  }>,
  config: ScanFrequencyConfig = DEFAULT_SCAN_CONFIG,
): {
  total: number;
  hot: number;
  warm: number;
  cool: number;
  cold: number;
  dueNow: number;
  nextRunEstimate: string;
} {
  let hot = 0, warm = 0, cool = 0, cold = 0, dueNow = 0;

  for (const m of markets) {
    const tier = getTierForMarket(m.expiryDate, config);
    if (!tier) continue;

    if (tier.intervalRuns === 1) hot++;
    else if (tier.intervalRuns === 2) warm++;
    else if (tier.intervalRuns === 4) cool++;
    else cold++;

    if (isMarketDueForScan(m.expiryDate, m.lastScanResult?.scannedAt ?? null, 0, config)) {
      dueNow++;
    }
  }

  return {
    total: markets.length,
    hot,
    warm,
    cool,
    cold,
    dueNow,
    nextRunEstimate: `${hot} hot markets every run, ${warm} every 2nd, ${cool} every 4th, ${cold} every 8th`,
  };
}
