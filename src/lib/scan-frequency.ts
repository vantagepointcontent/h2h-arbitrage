/**
 * Dynamic scan frequency configuration for H2H Arbitrage
 *
 * Markets are bucketed by days-to-expiry into tiers.
 * Default frequencies (customisable via /api/scan-config):
 *   - ≤ 7 days:   every 5 minutes  (near-expiry, high volatility)
 *   - ≤ 30 days:  every 15 minutes (medium term)
 *   - > 30 days:  every 60 minutes (long term, price-stable)
 *
 * Config is persisted to data/scan-config.json.
 */
import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "data", "scan-config.json");

export interface ScanTier {
  label: string;
  maxDays: number;     // ≤ this many days
  intervalMs: number;  // scan frequency in ms
}

export interface ScanConfig {
  tiers: ScanTier[];
  lastUpdated: string;
}

export const DEFAULT_TIERS: ScanTier[] = [
  { label: "Hot", maxDays: 7,   intervalMs: 5 * 60 * 1000 },    // 5 min
  { label: "Warm", maxDays: 30,  intervalMs: 15 * 60 * 1000 },   // 15 min
  { label: "Cold", maxDays: 365, intervalMs: 60 * 60 * 1000 },   // 1 hour
];

export function isValidScanTiers(value: unknown): value is ScanTier[] {
  if (!Array.isArray(value) || value.length !== DEFAULT_TIERS.length) return false;
  return value.every((tier, index) => {
    if (!tier || typeof tier !== 'object') return false;
    const candidate = tier as Partial<ScanTier>;
    const expected = DEFAULT_TIERS[index];
    return candidate.label === expected.label
      && Number.isFinite(candidate.maxDays) && candidate.maxDays! > 0
      && Number.isFinite(candidate.intervalMs) && candidate.intervalMs! >= 60_000
      && candidate.intervalMs! <= 86_400_000
      && (index === 0 || candidate.maxDays! > (value[index - 1] as ScanTier).maxDays);
  });
}

export function parseScanConfigTiers(value: unknown): { tiers: ScanTier[] } | { error: string } {
  if (!isValidScanTiers(value)) {
    return { error: 'tiers must contain ordered Hot, Warm, and Cold entries with positive maxDays and intervals from 1 minute to 24 hours' };
  }
  return { tiers: value };
}

export function getDefaultConfig(): ScanConfig {
  return {
    tiers: DEFAULT_TIERS,
    lastUpdated: new Date().toISOString(),
  };
}

export function loadScanConfig(): ScanConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as ScanConfig;
    if (!isValidScanTiers(config.tiers)) throw new Error('Invalid scan tier config');
    return config;
  } catch {
    const cfg = getDefaultConfig();
    saveScanConfig(cfg);
    return cfg;
  }
}

export function saveScanConfig(cfg: ScanConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function getTierForMarket(
  expiryDate: string | null | undefined,
  tiers: ScanTier[],
): ScanTier | null {
  if (!expiryDate) return tiers[tiers.length - 1] || null;
  const days = (new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (days <= 0) return null; // expired
  for (const tier of tiers) {
    if (days <= tier.maxDays) return tier;
  }
  return tiers[tiers.length - 1] || null;
}

export function isMarketDueForScan(
  market: { lastScannedAt?: string; expiryDate?: string | null },
  tiers: ScanTier[],
): boolean {
  const tier = getTierForMarket(market.expiryDate, tiers);
  if (!tier) return false;
  const last = market.lastScannedAt ? new Date(market.lastScannedAt).getTime() : 0;
  return Date.now() - last >= tier.intervalMs;
}

export interface ScanPlan {
  hot: number;   // ≤ 7 days
  warm: number;  // 8-30 days
  cold: number;  // > 30 days
  total: number;
  dueNow: { hot: number; warm: number; cold: number };
}

export function getScanPlanSummary(
  markets: Array<{ expiryDate?: string | null; lastScannedAt?: string }>,
  tiers: ScanTier[],
): ScanPlan {
  const plan: ScanPlan = { hot: 0, warm: 0, cold: 0, total: markets.length, dueNow: { hot: 0, warm: 0, cold: 0 } };
  for (const m of markets) {
    const tier = getTierForMarket(m.expiryDate, tiers);
    if (!tier) continue;
    const label = tier.label.toLowerCase() as "hot" | "warm" | "cold";
    plan[label]++;
    if (isMarketDueForScan(m, tiers)) plan.dueNow[label]++;
  }
  return plan;
}

export function sortMarketsByScanPriority<T extends { expiryDate?: string | null; lastScannedAt?: string }>(
  markets: T[],
  tiers: ScanTier[],
): T[] {
  return [...markets].sort((a, b) => {
    const tierA = getTierForMarket(a.expiryDate, tiers);
    const tierB = getTierForMarket(b.expiryDate, tiers);
    // Hot first, then warm, then cold
    const priorityA = tierA ? tiers.indexOf(tierA) : 999;
    const priorityB = tierB ? tiers.indexOf(tierB) : 999;
    if (priorityA !== priorityB) return priorityA - priorityB;
    // Within same tier: least recently scanned first
    const lastA = a.lastScannedAt ? new Date(a.lastScannedAt).getTime() : 0;
    const lastB = b.lastScannedAt ? new Date(b.lastScannedAt).getTime() : 0;
    return lastA - lastB;
  });
}
