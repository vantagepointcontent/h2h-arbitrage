// page-shared.ts — shared types, storage helpers, and utils for the main views.
// Extracted from page.tsx (PERF-002 split). No behavior changes.

// ─── Generic localStorage helpers ───

function getStored<T>(key: string, fallback: T, validate?: (v: T) => boolean): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = JSON.parse(raw) as T;
    return validate && !validate(v) ? fallback : v;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* quota exceeded – ignore */ }
}

// ─── Storage keys ───
export const MF_SELECTED_IDS_KEY = "h2h-mf-selected-ids";
export const MF_CATEGORIES_KEY = "h2h-mf-categories";
export const MF_EXPIRY_DAYS_KEY = "h2h-mf-expiry-days";
export const FAVORITE_IDS_KEY = "h2h-favorites";
export const CUSTOM_TITLES_KEY = "h2h-custom-titles";
export const MAX_CUSTOM_TITLE_LEN = 100;
export const MF_AUTO_REFRESH_KEY = "h2h-mf-auto-refresh";
export const SIDEBAR_OPEN_KEY = "h2h-sidebar-open";

// ─── Typed accessors ───
export const getStoredMfCategories = (): string[] => getStored<string[]>(MF_CATEGORIES_KEY, []);
export const persistMfCategories = (cats: string[]): void => persist(MF_CATEGORIES_KEY, cats);

export const getStoredMfExpiryDays = (): number =>
  getStored<number>(MF_EXPIRY_DAYS_KEY, 365, (n) => Number.isFinite(n) && n >= 1 && n <= 365);
export const persistMfExpiryDays = (days: number): void => persist(MF_EXPIRY_DAYS_KEY, days);

export const getStoredMfSelectedIds = (): Set<string> =>
  new Set(getStored<string[]>(MF_SELECTED_IDS_KEY, []));
export const persistMfSelectedIds = (ids: Set<string>): void => persist(MF_SELECTED_IDS_KEY, [...ids]);

export const getStoredFavoriteIds = (): Set<string> =>
  new Set(getStored<string[]>(FAVORITE_IDS_KEY, []));
export const persistFavoriteIds = (ids: Set<string>): void => persist(FAVORITE_IDS_KEY, [...ids]);

export const getStoredCustomTitles = (): Record<string, string> =>
  getStored<Record<string, string>>(CUSTOM_TITLES_KEY, {});

/** Persist a single custom title to localStorage */
export function setCustomTitle(marketId: string, title: string): void {
  const titles = getStoredCustomTitles();
  titles[marketId] = title;
  persist(CUSTOM_TITLES_KEY, titles);
}

/** Remove a custom title from localStorage */
export function removeCustomTitle(marketId: string): void {
  const titles = getStoredCustomTitles();
  delete titles[marketId];
  persist(CUSTOM_TITLES_KEY, titles);
}

export const getStoredMfAutoRefresh = (): boolean => getStored<boolean>(MF_AUTO_REFRESH_KEY, true);
export const persistMfAutoRefresh = (val: boolean): void => persist(MF_AUTO_REFRESH_KEY, val);

export const getStoredSidebarOpen = (): boolean => getStored<boolean>(SIDEBAR_OPEN_KEY, true);
export const persistSidebarOpen = (val: boolean): void => persist(SIDEBAR_OPEN_KEY, val);

export interface ArbitrageInfo {
  strategy: string;
  kalshiStake: number;
  pmStake: number;
  expectedProfit: number;
  roiPct: number;
  apyPct?: number;
  buyPlatform: "kalshi" | "polymarket" | null;
  buyPrice: number;
  sellPlatform: "kalshi" | "polymarket" | null;
  sellPrice: number;
}

export interface UnifiedOutcome {
  artist: string;
  kalshi: {
    ticker: string;
    yesBid: number;
    yesAsk: number;
    noBid: number;
    noAsk: number;
    lastPrice: number;
    volume24h?: string;
    yesAskDepth?: string;
    noAskDepth?: string;
  } | null;
  polymarket: {
    marketId: string;
    conditionId: string;
    yesPrice: number;
    noPrice: number;
    bestBid: number;
    bestAsk: number;
    lastTradePrice: number;
    volume?: string;
    liquidity?: string;
    askDepth?: number;
    noAskDepth?: number;
  } | null;
  arbitrage: ArbitrageInfo;
  source?: "auto" | "manual";
}

export interface UnmatchedKalshi {
  ticker: string;
  title: string;
  artist?: string;
  yesAsk: number;
  noAsk: number;
}

export interface UnmatchedPolymarket {
  conditionId: string;
  title: string;
  yesPrice: number;
  noPrice: number;
}

export interface ManualMatch {
  id: string;
  kalshiTicker: string;
  kalshiTitle: string;
  pmConditionId: string;
  pmTitle: string;
  createdAt: string;
}

export interface LastScanResult {
  bestRoiPct: number;
  bestProfit: number;
  strategy: string;
  outcomeCount: number;
  matchedCount: number;
  kalshiCount: number;
  pmCount: number;
  scannedAt: string;
  pmClosed?: boolean; // UI-013: PM reports market closed (endDate may still be future)
  allArbs?: {
    artist: string;
    roiPct: number;
    expectedProfit: number;
    strategy: string;
  }[];
}

export interface SavedMarket {
  id: string;
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  category?: string;
  createdAt: string;
  expiryDate?: string | null;
  favorited?: boolean;
  lastScanResult?: LastScanResult | null;
  liveResult?: {
    bestRoiPct: number;
    bestProfit: number;
    strategy: string;
    scannedAt: string;
    kalshiCount?: number;
    pmCount?: number;
    matchedCount?: number;
    allArbs?: {
      artist: string;
      roiPct: number;
      expectedProfit: number;
      strategy: string;
      totalStake?: number;
    }[];
  } | null;
}

export interface ScanResult {
  eventTitle: string;
  kalshiCount: number;
  pmCount: number;
  matchedCount: number;
  expiryDate?: string;
  kalshiRawCount?: number;
  pmRawCount?: number;
  pmFilteredCount?: number;
  kalshiFetchSource?: string;
  clobHitCount?: number;
  clobMissCount?: number;
  expired?: boolean;
  noPrices?: boolean;
  outcomes: UnifiedOutcome[];
  unmatchedKalshi: UnmatchedKalshi[];
  unmatchedPolymarket: UnmatchedPolymarket[];
}

/* ── Utility helpers ── */
export function formatPercent(n: number): string {
  return Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n / 100);
}

export function formatCurrency(dollars: number): string {
  return Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(dollars);
}

/** Sum of all positive expected profits from allArbs */
export function getTotalProfit(allArbs?: { expectedProfit: number }[] | null): number {
  if (!allArbs) return 0;
  return allArbs
    .filter(a => a.expectedProfit > 0)
    .reduce((sum, a) => sum + a.expectedProfit, 0);
}

/** Format profit display: "$15.00" for single position, "$15.00 ($24.00 total)" for multiple */
export function formatProfitDisplay(bestProfit: number, allArbs?: { expectedProfit: number }[] | null): string {
  if (bestProfit === 0) return "";
  const profitableCount = allArbs ? allArbs.filter(a => a.expectedProfit > 0).length : 0;
  if (profitableCount <= 1) {
    return formatCurrency(bestProfit);
  }
  const totalProfit = getTotalProfit(allArbs);
  return `${formatCurrency(bestProfit)} (${formatCurrency(totalProfit)} total)`;
}

/** Sum of all positive expected profits from scan outcomes */
export function getTotalProfitFromOutcomes(outcomes: UnifiedOutcome[]): number {
  return outcomes
    .filter(o => o.arbitrage.expectedProfit > 0)
    .reduce((sum, o) => sum + o.arbitrage.expectedProfit, 0);
}

export function formatExpiry(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function timeUntilExpiry(iso?: string | null): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return "Expired";
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

/** Compact relative time: "2min", "1h", "3d". No "ago" suffix. */
export function formatRelativeTime(iso?: string | null): string {
  if (!iso) return "—";
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}min`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d`;
}

/** Check whether a saved market has at least one matched outcome pair */
export function isMatched(m: SavedMarket): boolean {
  if (m.liveResult && m.liveResult.allArbs && m.liveResult.allArbs.length > 0) return true;
  return (m.lastScanResult?.matchedCount ?? 0) > 0;
}


// ─── Types used across components ───
export type OverviewSort = "name" | "roi" | "expiry" | "apy" | "profit" | "strategy" | "matched" | "arbs" | "scanned";

export function getTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
