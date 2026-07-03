// page-shared.ts — shared types, storage helpers, and utils for the main views.
// Extracted from page.tsx (PERF-002 split). No behavior changes.

// ─── Selection storage key ───
export const MF_SELECTED_IDS_KEY = "h2h-mf-selected-ids";

// ─── MF category filter storage key ───
export const MF_CATEGORIES_KEY = "h2h-mf-categories";
export const MF_EXPIRY_DAYS_KEY = "h2h-mf-expiry-days";

/** Read persisted selected categories from localStorage */
export function getStoredMfCategories(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MF_CATEGORIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Persist selected categories to localStorage */
export function persistMfCategories(cats: string[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MF_CATEGORIES_KEY, JSON.stringify(cats));
  } catch { /* quota exceeded – ignore */ }
}

/** Read persisted expiry days from localStorage */
export function getStoredMfExpiryDays(): number {
  if (typeof window === "undefined") return 365;
  try {
    const raw = localStorage.getItem(MF_EXPIRY_DAYS_KEY);
    const n = raw ? parseInt(raw, 10) : 365;
    return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 365;
  } catch {
    return 365;
  }
}

/** Persist expiry days to localStorage */
export function persistMfExpiryDays(days: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MF_EXPIRY_DAYS_KEY, String(days));
  } catch { /* quota exceeded – ignore */ }
}

/** Read persisted selection IDs from localStorage */
export function getStoredMfSelectedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(MF_SELECTED_IDS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

/** Persist selection IDs to localStorage */
export function persistMfSelectedIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MF_SELECTED_IDS_KEY, JSON.stringify([...ids]));
  } catch { /* quota exceeded – ignore */ }
}

// ─── Favorites storage key ───
export const FAVORITE_IDS_KEY = "h2h-favorites";

/** Read persisted favorite IDs from localStorage */
export function getStoredFavoriteIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(FAVORITE_IDS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

/** Persist favorite IDs to localStorage */
export function persistFavoriteIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(FAVORITE_IDS_KEY, JSON.stringify([...ids]));
  } catch { /* quota exceeded – ignore */ }
}

// ─── Matched-only filter storage key ──
export const MATCHED_ONLY_KEY = "h2h-hide-unmatched";

/** Read persisted matched-only filter from localStorage (default: true) */
export function getStoredHideUnmatched(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(MATCHED_ONLY_KEY);
    if (raw !== null) return JSON.parse(raw);
  } catch { /* ignore */ }
  return true; // default: show matched only
}

/** Persist matched-only filter to localStorage */
export function persistHideUnmatched(val: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MATCHED_ONLY_KEY, JSON.stringify(val));
  } catch { /* quota exceeded – ignore */ }
}

// ─── Custom title storage key ──
export const CUSTOM_TITLES_KEY = "h2h-custom-titles";
export const MAX_CUSTOM_TITLE_LEN = 100;

/** Read persisted custom titles from localStorage (marketId → customTitle) */
export function getStoredCustomTitles(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(CUSTOM_TITLES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Persist a single custom title to localStorage */
export function setCustomTitle(marketId: string, title: string): void {
  if (typeof window === "undefined") return;
  try {
    const titles: Record<string, string> = getStoredCustomTitles();
    titles[marketId] = title;
    localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify(titles));
  } catch { /* quota exceeded – ignore */ }
}

/** Remove a custom title from localStorage */
export function removeCustomTitle(marketId: string): void {
  if (typeof window === "undefined") return;
  try {
    const titles: Record<string, string> = getStoredCustomTitles();
    delete titles[marketId];
    localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify(titles));
  } catch { /* quota exceeded — ignore */ }
}

// ─── Auto-refresh toggle storage key ──
export const MF_AUTO_REFRESH_KEY = "h2h-mf-auto-refresh";

export function getStoredMfAutoRefresh(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(MF_AUTO_REFRESH_KEY);
    if (raw !== null) return JSON.parse(raw);
  } catch { /* ignore */ }
  return true; // default: enabled
}

export function persistMfAutoRefresh(val: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MF_AUTO_REFRESH_KEY, JSON.stringify(val));
  } catch { /* quota exceeded — ignore */ }
}

export const SIDEBAR_OPEN_KEY = "h2h-sidebar-open";

export function getStoredSidebarOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(SIDEBAR_OPEN_KEY);
    if (raw !== null) return JSON.parse(raw);
  } catch { /* ignore */ }
  return true;
}

export function persistSidebarOpen(val: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SIDEBAR_OPEN_KEY, JSON.stringify(val));
  } catch { /* quota exceeded — ignore */ }
}

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
