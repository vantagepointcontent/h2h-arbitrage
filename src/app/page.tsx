"use client";

import React from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Zap,
  Scan,
  Link2,
  Activity,
  Clock,
  TrendingUp,
  ExternalLink,
  Loader2,
  AlertCircle,
  Save,
  RefreshCw,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Bookmark,
  Plus,
  BarChart3,
  X,
  Calendar,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Edit3,
  Pencil,
  Hand,
  Unlink,
  LayoutGrid,
  Rows3,
  Search,
  Filter,
  Globe,
  Download,
  Sun,
  Moon,
  Check,
  Star,
} from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { DateTimePicker } from "@/components/DateTimePicker";
import { useAlertSystem, ToastContainer, AlertSettingsPanel } from "@/components/AlertSystem";
import { syncArbDurations, getArbDurationString, getArbDurationColor, formatDuration, loadArbDurations } from "@/lib/arb-duration";
import { Bookmaker1on1 } from "@/app/components/Bookmaker1on1";
import { CouplingSuggestions } from "@/app/components/CouplingSuggestions";
import { CATEGORIES } from "@/lib/categories";
import { DualBrowserPanels } from "@/components/EmbeddedBrowserPanel";
import { OutcomeTableBody } from "@/app/components/OutcomeTableBody";

// ─── Selection storage key ───
const MF_SELECTED_IDS_KEY = "h2h-mf-selected-ids";

// ─── MF category filter storage key ───
const MF_CATEGORIES_KEY = "h2h-mf-categories";

/** Read persisted selected categories from localStorage */
function getStoredMfCategories(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MF_CATEGORIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Persist selected categories to localStorage */
function persistMfCategories(cats: string[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MF_CATEGORIES_KEY, JSON.stringify(cats));
  } catch { /* quota exceeded – ignore */ }
}

/** Read persisted selection IDs from localStorage */
function getStoredMfSelectedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(MF_SELECTED_IDS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

/** Persist selection IDs to localStorage */
function persistMfSelectedIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MF_SELECTED_IDS_KEY, JSON.stringify([...ids]));
  } catch { /* quota exceeded – ignore */ }
}

// ─── Favorites storage key ───
const FAVORITE_IDS_KEY = "h2h-favorites";

/** Read persisted favorite IDs from localStorage */
function getStoredFavoriteIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(FAVORITE_IDS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

/** Persist favorite IDs to localStorage */
function persistFavoriteIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(FAVORITE_IDS_KEY, JSON.stringify([...ids]));
  } catch { /* quota exceeded – ignore */ }
}

// ─── Matched-only filter storage key ──
const MATCHED_ONLY_KEY = "h2h-hide-unmatched";

/** Read persisted matched-only filter from localStorage (default: true) */
function getStoredHideUnmatched(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(MATCHED_ONLY_KEY);
    if (raw !== null) return JSON.parse(raw);
  } catch { /* ignore */ }
  return true; // default: show matched only
}

/** Persist matched-only filter to localStorage */
function persistHideUnmatched(val: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MATCHED_ONLY_KEY, JSON.stringify(val));
  } catch { /* quota exceeded – ignore */ }
}

// ─── Custom title storage key ──
const CUSTOM_TITLES_KEY = "h2h-custom-titles";
const MAX_CUSTOM_TITLE_LEN = 100;

/** Read persisted custom titles from localStorage (marketId → customTitle) */
function getStoredCustomTitles(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(CUSTOM_TITLES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Persist a single custom title to localStorage */
function setCustomTitle(marketId: string, title: string): void {
  if (typeof window === "undefined") return;
  try {
    const titles: Record<string, string> = getStoredCustomTitles();
    titles[marketId] = title;
    localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify(titles));
  } catch { /* quota exceeded – ignore */ }
}

/** Remove a custom title from localStorage */
function removeCustomTitle(marketId: string): void {
  if (typeof window === "undefined") return;
  try {
    const titles: Record<string, string> = getStoredCustomTitles();
    delete titles[marketId];
    localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify(titles));
  } catch { /* quota exceeded — ignore */ }
}

// ─── Auto-refresh toggle storage key ──
const MF_AUTO_REFRESH_KEY = "h2h-mf-auto-refresh";

function getStoredMfAutoRefresh(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(MF_AUTO_REFRESH_KEY);
    if (raw !== null) return JSON.parse(raw);
  } catch { /* ignore */ }
  return true; // default: enabled
}

function persistMfAutoRefresh(val: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MF_AUTO_REFRESH_KEY, JSON.stringify(val));
  } catch { /* quota exceeded — ignore */ }
}

interface ArbitrageInfo {
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

interface UnifiedOutcome {
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

interface UnmatchedKalshi {
  ticker: string;
  title: string;
  yesPrice: number;
  noPrice: number;
}

interface UnmatchedPolymarket {
  conditionId: string;
  title: string;
  yesPrice: number;
  noPrice: number;
}

interface ManualMatch {
  id: string;
  kalshiTicker: string;
  kalshiTitle: string;
  pmConditionId: string;
  pmTitle: string;
  createdAt: string;
}

interface LastScanResult {
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

interface SavedMarket {
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
    allArbs?: {
      artist: string;
      roiPct: number;
      expectedProfit: number;
      strategy: string;
      totalStake?: number;
    }[];
  } | null;
}

interface ScanResult {
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
  allOutcomes: UnifiedOutcome[];
  unmatchedKalshi: UnmatchedKalshi[];
  unmatchedPolymarket: UnmatchedPolymarket[];
}

/* ── Utility helpers ── */
function formatPercent(n: number): string {
  return Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n / 100);
}

function formatCurrency(cents: number): string {
  return Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** Sum of all positive expected profits from allArbs */
function getTotalProfit(allArbs?: { expectedProfit: number }[] | null): number {
  if (!allArbs) return 0;
  return allArbs
    .filter(a => a.expectedProfit > 0)
    .reduce((sum, a) => sum + a.expectedProfit, 0);
}

/** Format profit display: "$15.00" for single position, "$15.00 ($24.00 total)" for multiple */
function formatProfitDisplay(bestProfit: number, allArbs?: { expectedProfit: number }[] | null): string {
  if (bestProfit === 0) return "";
  const profitableCount = allArbs ? allArbs.filter(a => a.expectedProfit > 0).length : 0;
  if (profitableCount <= 1) {
    return formatCurrency(bestProfit);
  }
  const totalProfit = getTotalProfit(allArbs);
  return `${formatCurrency(bestProfit)} (${formatCurrency(totalProfit)} total)`;
}

/** Sum of all positive expected profits from scan outcomes */
function getTotalProfitFromOutcomes(outcomes: UnifiedOutcome[]): number {
  return outcomes
    .filter(o => o.arbitrage.expectedProfit > 0)
    .reduce((sum, o) => sum + o.arbitrage.expectedProfit, 0);
}

function formatExpiry(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function timeUntilExpiry(iso?: string | null): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return "Expired";
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

/** Check whether a saved market has at least one matched outcome pair */
function isMatched(m: SavedMarket): boolean {
  if (m.liveResult && m.liveResult.allArbs && m.liveResult.allArbs.length > 0) return true;
  return (m.lastScanResult?.matchedCount ?? 0) > 0;
}

/* ── Stat Card ── */
function StatCard({ label, value, icon, color, valueSize, compact }: { label: string; value: string | number; icon: React.ReactNode; color: "green" | "blue" | "purple" | "yellow" | "orange" | "red"; valueSize?: "xs"; compact?: boolean }) {
  const colorMap = {
    green: "text-[#5DBE81]", blue: "text-[#5DBE81]", purple: "text-[#a855f7]",
    yellow: "text-[#facc15]", orange: "text-[#ef4444]", red: "text-[#ef4444]",
  };
  const bgMap = {
    green: "bg-[#5DBE81]/10", blue: "bg-[#5DBE81]/10", purple: "bg-[#a855f7]/10",
    yellow: "bg-[#facc15]/10", orange: "bg-[#ef4444]/10", red: "bg-[#ef4444]/10",
  };
  const padClass = compact ? "p-2.5" : "p-4";
  const labelGap = compact ? "mb-1" : "mb-2";
  const iconPad = compact ? "p-1" : "p-1.5";
  const textSize = compact ? "text-xs" : (valueSize === "xs" ? "text-sm" : "text-2xl");
  const labelTextSize = compact ? "text-[10px]" : "text-xs";
  return (
    <div className={`rounded-xl border border-[#182533] bg-[#17212B] ${padClass}`}>
      <div className={`flex items-center gap-2 ${labelGap}`}>
        <span className={`${colorMap[color]} ${iconPad} rounded-lg ${bgMap[color]}`}>{icon}</span>
        <span className={`${labelTextSize} text-[#5E6875]`}>{label}</span>
      </div>
      <div className={`${textSize} font-bold text-[#FFFFFF]`}>{value}</div>
    </div>
  );
}

/* ── Swipe gesture hook ── */
function useSwipeGesture(onLeft: () => void, onRight: () => void) {
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const threshold = 60;

  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      startX.current = e.touches[0].clientX;
      startY.current = e.touches[0].clientY;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (startX.current === null || startY.current === null) return;
      const dx = e.changedTouches[0].clientX - startX.current;
      const dy = e.changedTouches[0].clientY - startY.current;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > threshold) {
        if (dx < 0) onLeft(); else onRight();
      }
      startX.current = null;
      startY.current = null;
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [onLeft, onRight]);
}

/* ── Main App ── */
// ─── Types used across components ───
type OverviewSort = "name" | "roi" | "expiry" | "apy";

export default function Home() {
  const [kalshiUrl, setKalshiUrl] = useState("https://kalshi.com/markets/kxfeaturedrake/who-will-be-featured-on-drake-album/kxfeaturedrake");
  const [pmUrl, setPmUrl] = useState("https://polymarket.com/event/who-will-be-featured-on-iceman");
  const [capital, setCapital] = useState(1000);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [expandedArtist, setExpandedArtist] = useState<string | null>(null);
  const [manualMatches, setManualMatches] = useState<ManualMatch[]>([]);
  const [selectedKalshi, setSelectedKalshi] = useState<UnmatchedKalshi | null>(null);
  const [selectedPM, setSelectedPM] = useState<UnmatchedPolymarket | null>(null);
  const [manualMatchMsg, setManualMatchMsg] = useState("");
  const [sortField, setSortField] = useState<"roi" | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [lastScanTime, setLastScanTime] = useState<number>(0);
  const previousPricesRef = useRef<Map<string, { kYes: number; pYes: number }>>(new Map());
  const [priceChanges, setPriceChanges] = useState<Map<string, "up" | "down" | null>>(new Map());
  const [pollTimer, setPollTimer] = useState<number>(0);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const activeScanRef = useRef(false);
  const pollingActiveRef = useRef(false);

  // ── Unlink state (GEN-12: Manual unmatch for automated pairings) ──
  interface UnlinkedPair {
    outcome: UnifiedOutcome;
    unlinkedAt: number;
    undoTimeout: ReturnType<typeof setTimeout>;
  }
  const [unlinkedPairs, setUnlinkedPairs] = useState<Map<string, UnlinkedPair>>(new Map());
  const UNLINK_UNDO_MS = 10000; // 10 seconds

  const [savedMarkets, setSavedMarkets] = useState<SavedMarket[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useSwipeGesture(
    () => { setMobileMenuOpen(false); },
    () => { setMobileMenuOpen(true); },
  );
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeMarketId, setActiveMarketId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"scan" | "overview" | "marketfinder">("overview");

    // Dual panel layout + auto-refresh
  const [panelLayout, setPanelLayout] = useState<"sidebyside" | "stacked">("stacked");
  const [embedRefreshCounter, setEmbedRefreshCounter] = useState(0);

  // Refs for values used inside useCallback
  const savedMarketsRef = useRef<SavedMarket[]>(savedMarkets);
  const kalshiUrlRef = useRef(kalshiUrl);
  const pmUrlRef = useRef(pmUrl);
  const activeMarketIdRef = useRef(activeMarketId);

  useEffect(() => { savedMarketsRef.current = savedMarkets; }, [savedMarkets]);
  useEffect(() => { kalshiUrlRef.current = kalshiUrl; }, [kalshiUrl]);
  useEffect(() => { pmUrlRef.current = pmUrl; }, [pmUrl]);
  useEffect(() => { activeMarketIdRef.current = activeMarketId; }, [activeMarketId]);

  // Handle browser back/forward via popstate
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const state = e.state;
      if (state?.view === "overview") {
        stopPolling();
        setViewMode("overview");
        setActiveMarketId(null);
      } else if (state?.view === "marketfinder") {
        stopPolling();
        setViewMode("marketfinder");
        setActiveMarketId(null);
      } else if (state?.view === "scan") {
        if (state?.marketId) {
          const m = savedMarketsRef.current.find((m) => m.id === state.marketId);
          if (m) {
            setKalshiUrl(m.kalshiUrl);
            setPmUrl(m.polymarketUrl);
            setActiveMarketId(m.id);
            kalshiUrlRef.current = m.kalshiUrl;
            pmUrlRef.current = m.polymarketUrl;
            activeMarketIdRef.current = m.id;
            setResult(null);
            previousPricesRef.current = new Map();
            setPriceChanges(new Map());
            handleScanWithUrls(m.kalshiUrl, m.polymarketUrl);
          } else {
            setViewMode("scan");
          }
        } else {
          setViewMode("scan");
        }
      } else {
        stopPolling();
        setViewMode("overview");
        setActiveMarketId(null);
        window.history.replaceState({ view: "overview" }, "", "/?view=overview");
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // On first mount: check query param for direct links and sync react state
  useEffect(() => {
    const syncFromUrl = async () => {
      const params = new URLSearchParams(window.location.search);
      const view = params.get("view");
      const marketId = params.get("id");

      const initialMarkets = await loadSavedMarkets();
      savedMarketsRef.current = initialMarkets;

      if (view === "scan" && marketId) {
        const m = (initialMarkets as SavedMarket[]).find((m) => m.id === marketId);
        if (m) {
          setKalshiUrl(m.kalshiUrl);
          setPmUrl(m.polymarketUrl);
          setActiveMarketId(m.id);
          kalshiUrlRef.current = m.kalshiUrl;
          pmUrlRef.current = m.polymarketUrl;
          activeMarketIdRef.current = m.id;
          setViewMode("scan");
          handleScanWithUrls(m.kalshiUrl, m.polymarketUrl);
        } else {
          setViewMode("scan");
        }
      } else if (view === "overview") {
        setViewMode("overview");
      } else if (view === "marketfinder") {
        setViewMode("marketfinder");
        // Read multi-select categories from URL (?cats=a,b,c), fallback to legacy ?category=X
        const catsParam = params.get("cats");
        const legacyCat = params.get("category");
        if (catsParam) {
          const cats = catsParam.split(",");
          if (cats.every(c => CATEGORIES.includes(c))) {
            setMfCategories(cats);
          }
        } else if (legacyCat && CATEGORIES.includes(legacyCat)) {
          setMfCategories([legacyCat]);
        }
      } else {
        setViewMode("overview");
      }
    };
    syncFromUrl();
  }, []);

  // Stop polling helper
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    setIsPolling(false);
    pollingActiveRef.current = false;
  }, []);

  // Start polling
  const startPolling = useCallback(() => {
    stopPolling();
    setIsPolling(true);
    pollingActiveRef.current = true;
  }, [stopPolling]);

  // Scan handler
  const handleScan = async (useDefaults: boolean) => {
    const kUrl = useDefaults
      ? "https://kalshi.com/markets/kxfeaturedrake/who-will-be-featured-on-drake-album/kxfeaturedrake"
      : kalshiUrlRef.current;
    const pUrl = useDefaults
      ? "https://polymarket.com/event/who-will-be-featured-on-iceman"
      : pmUrlRef.current;
    await handleScanWithUrls(kUrl, pUrl);
  };

  const handleScanWithUrls = async (kUrl: string, pUrl: string) => {
    setLoading(true);
    setError("");
    setResult(null);
    previousPricesRef.current = new Map();
    setPriceChanges(new Map());

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kalshiUrl: kUrl, polymarketUrl: pUrl, capital: capital }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult(data);
        setLastUpdated(new Date());
        setLastScanTime(Date.now());
        // Trigger embedded panel refresh on new scan
        setEmbedRefreshCounter((c) => c + 1);
        // Record initial prices for change detection
        const prices = new Map<string, { kYes: number; pYes: number }>();
        data.allOutcomes.forEach((o: UnifiedOutcome) => {
          if (o.kalshi && o.polymarket) {
            prices.set(o.artist, { kYes: o.kalshi.yesAsk, pYes: o.polymarket.yesPrice });
          }
        });
        previousPricesRef.current = prices;
      } else {
        setError(data.error || "Scan failed");
      }
    } catch (err: any) {
      setError(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  };

  // Saved markets
  const loadSavedMarkets = async (): Promise<SavedMarket[]> => {
    try {
      const res = await fetch("/api/saved-markets");
      if (res.ok) {
        const data = await res.json();
        setSavedMarkets(data.markets || []);
        return data.markets || [];
      }
    } catch { /* ignore */ }
    return [];
  };

  const loadManualMatches = async () => {
    try {
      const res = await fetch("/api/manual-matches");
      if (res.ok) {
        const data = await res.json();
        setManualMatches(data.matches || []);
      }
    } catch { /* ignore */ }
  };

  // Scan ALL saved markets with LIVE prices
  const scanAllMarkets = async () => {
    if (scanningAll) return;
    setScanningAll(true);
    setScanAllError("");
    const failed: string[] = [];
    const refreshed: { id: string; result: any }[] = [];

    for (const market of savedMarketsRef.current) {
      try {
        const res = await fetch(`/api/refresh?_=${Date.now()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kalshiUrl: market.kalshiUrl,
            polymarketUrl: market.polymarketUrl,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          refreshed.push({ id: market.id, result: data });
        } else {
          failed.push(market.eventTitle);
        }
      } catch {
        failed.push(market.eventTitle);
      }
    }

    setSavedMarkets(prev => prev.map(m => {
      const r = refreshed.find(x => x.id === m.id);
      if (!r) return m;
      return {
        ...m,
        liveResult: {
          bestRoiPct: r.result.bestRoiPct ?? 0,
          bestProfit: r.result.bestProfit ?? 0,
          strategy: r.result.strategy || "",
          scannedAt: r.result.scannedAt || new Date().toISOString(),
          allArbs: (r.result.allArbs || []).map((a: any) => ({
            artist: a.artist,
            roiPct: a.roiPct,
            expectedProfit: a.expectedProfit,
            strategy: a.strategy,
            totalStake: a.totalStake,
          })),
        },
      };
    }));

    for (const r of refreshed) {
      const market = savedMarketsRef.current.find(m => m.id === r.id);
      if (market && r.result.bestRoiPct > 0) {
        alertSystem.checkAndFire(
          market.eventTitle,
          market.id,
          r.result.bestRoiPct,
          r.result.strategy || "",
          r.result.bestProfit ?? 0,
        );
      }
    }

    setScanningAll(false);
    if (failed.length > 0) {
      setScanAllError(`${failed.length} market${failed.length > 1 ? "s" : ""} failed to refresh`);
    }
  };

  // Delete saved market
  const deleteMarket = async (id: string) => {
    try {
      const res = await fetch(`/api/saved-markets/${id}`, { method: "DELETE" });
      if (res.ok) {
        await loadSavedMarkets();
        if (activeMarketId === id) {
          setActiveMarketId(null);
          setViewMode("overview");
          window.history.replaceState({ view: "overview" }, "", "/?view=overview");
        }
      }
    } catch { /* ignore */ }
  };

  // Save modal state
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingMarket, setEditingMarket] = useState<SavedMarket | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editExpiry, setEditExpiry] = useState("");

  const openSaveModal = () => setSaveModalOpen(true);
  const openEditModal = (m: SavedMarket) => {
    setEditingMarket(m);
    setEditTitle(m.eventTitle);
    setEditCategory(m.category || "");
    setEditExpiry(m.expiryDate ? m.expiryDate.substring(0, 10) : "");
    setEditModalOpen(true);
  };

  // Save market from scan result
  const saveMarket = async () => {
    if (!result) return;
    setSaving(true);
    try {
      const res = await fetch("/api/saved-markets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kalshiUrl: kalshiUrlRef.current,
          polymarketUrl: pmUrlRef.current,
          eventTitle: result.eventTitle,
        }),
      });
      if (res.ok) {
        await loadSavedMarkets();
        setSaveModalOpen(false);
      }
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  };

  // Edit market
  const saveEdit = async () => {
    if (!editingMarket) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/saved-markets/${editingMarket.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventTitle: editTitle,
          category: editCategory,
          expiryDate: editExpiry || null,
        }),
      });
      if (res.ok) {
        await loadSavedMarkets();
        setEditModalOpen(false);
      }
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  };

  // Manual match
  const onCreateMatch = async (kt: string, pcid: string, ktTitle: string, pmTitle: string) => {
    try {
      const res = await fetch("/api/manual-matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kalshiTicker: kt, pmConditionId: pcid, kalshiTitle: ktTitle, pmTitle }),
      });
      if (res.ok) {
        await loadManualMatches();
        setManualMatchMsg("Linked!");
        setTimeout(() => setManualMatchMsg(""), 2000);
      }
    } catch { /* ignore */ }
  };

  const onDeleteMatch = async (id: string) => {
    try {
      await fetch(`/api/manual-matches/${id}`, { method: "DELETE" });
      await loadManualMatches();
    } catch { /* ignore */ }
  };

  // Navigate to market detail
  const loadMarket = (m: SavedMarket) => {
    setKalshiUrl(m.kalshiUrl);
    setPmUrl(m.polymarketUrl);
    setActiveMarketId(m.id);
    kalshiUrlRef.current = m.kalshiUrl;
    pmUrlRef.current = m.polymarketUrl;
    activeMarketIdRef.current = m.id;
    setViewMode("scan");
    window.history.pushState({ view: "scan", marketId: m.id }, "", `/?view=scan&id=${m.id}`);
    handleScanWithUrls(m.kalshiUrl, m.polymarketUrl);
  };

  // View mode switcher
  const goToMarketFinder = () => {
    stopPolling();
    setViewMode("marketfinder");
    window.history.replaceState({ view: "marketfinder" }, "", "/?view=marketfinder");
  };

  // MF category filter — multi-select, updates state + URL
  const setMfCategoriesUrl = useCallback((cats: string[]) => {
    setMfCategories(cats);
    persistMfCategories(cats);
    const params = new URLSearchParams(window.location.search);
    params.set("view", "marketfinder");
    if (cats.length > 0) params.set("cats", cats.join(","));
    else params.delete("cats");
    window.history.replaceState({ view: "marketfinder" }, "", `/?${params.toString()}`);
  }, []);

  const goToOverview = () => {
    stopPolling();
    setViewMode("overview");
    window.history.replaceState({ view: "overview" }, "", "/?view=overview");
  };

  const goToScan = () => {
    stopPolling();
    setViewMode("scan");
    window.history.replaceState({ view: "scan" }, "", "/?view=scan");
  };

  // Sort helpers
  const [overviewSort, setOverviewSort] = useState<OverviewSort>("expiry");
  const [overviewSortDir, setOverviewSortDir] = useState<"asc" | "desc">("asc");
  const [overviewLayout, setOverviewLayout] = useState<"grid" | "table">("grid");
  const [overviewExpiryFilter, setOverviewExpiryFilter] = useState<"all" | "lte7" | "lte14" | "lte30">("all");
  const [overviewCategory, setOverviewCategory] = useState<string>("all");
  const [hideUnmatched, setHideUnmatched] = useState(getStoredHideUnmatched);
  const [scanningAll, setScanningAll] = useState(false);
  const [scanAllError, setScanAllError] = useState("");
  const [bookmakerView, setBookmakerView] = useState(false);

  // Favorites state (persisted to localStorage)
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(getStoredFavoriteIds);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [sidebarFavoritesOnly, setSidebarFavoritesOnly] = useState(false);

  // Toggle favorite for a market
  const toggleFavorite = useCallback((marketId: string) => {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      if (next.has(marketId)) next.delete(marketId);
      else next.add(marketId);
      return next;
    });
  }, []);

  // Bulk favorite/unfavorite selected markets
  const bulkFavorite = useCallback((selectedIds: Set<string>) => {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      for (const id of selectedIds) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);

  // Persist favorites to localStorage whenever they change
  useEffect(() => {
    persistFavoriteIds(favoriteIds);
  }, [favoriteIds]);

  // Persist hideUnmatched to localStorage whenever it changes
  useEffect(() => {
    persistHideUnmatched(hideUnmatched);
  }, [hideUnmatched]);

  // Auto-fetch state
  const [overviewLoading, setOverviewLoading] = useState(false);
  const overviewCacheRef = useRef<{ data: SavedMarket[]; fetchedAt: number }>({ data: [], fetchedAt: 0 });
  const OVERVIEW_CACHE_TTL_MS = 30000;

  // MarketFinder state
  const [mfMarkets, setMfMarkets] = useState<any[]>([]);
  const [mfLoading, setMfLoading] = useState(false);
  const [mfSyncing, setMfSyncing] = useState(false);
  const [mfError, setMfError] = useState("");
  const [mfLastSync, setMfLastSync] = useState<any>(null);
  const [mfSavingIds, setMfSavingIds] = useState<Set<string>>(new Set());
  const [mfExpiryFilter, setMfExpiryFilter] = useState<"all" | "lt24h" | "lt1h" | "lt15m">("all");
  // MF category filter — multi-select (empty = all categories)
  const [mfCategories, setMfCategories] = useState<string[]>(getStoredMfCategories);
  const mfAutoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // MF cache with TTL
  const mfCacheRef = useRef<{ data: any[]; fetchedAt: number }>({ data: [], fetchedAt: 0 });
  const MF_CACHE_TTL_MS = 30000;

  // MF spread threshold (configurable, default 14%)
  const [mfSpreadThreshold, setMfSpreadThreshold] = useState(14);

  // ── MF auto-refresh toggle (persisted, default: enabled) ──
  const [mfAutoRefreshEnabled, setMfAutoRefreshEnabled] = useState(getStoredMfAutoRefresh);

  // ── MF bulk selection state (persisted to localStorage) ──
  const [mfSelectedIds, setMfSelectedIds] = useState<Set<string>>(getStoredMfSelectedIds);
  const [mfBulkSaving, setMfBulkSaving] = useState(false);
  const [mfBulkMsg, setMfBulkMsg] = useState("");

  // Alert system
  const alertSystem = useAlertSystem();
  const [alertSettingsOpen, setAlertSettingsOpen] = useState(false);

  // Sidebar sort
  type SidebarSort = "name" | "roi" | "expiry" | "apy";
  const [sidebarSort, setSidebarSort] = useState<SidebarSort>("name");
  const [sidebarSortDir, setSidebarSortDir] = useState<"asc" | "desc">("asc");

  // Load saved markets on mount
  useEffect(() => { loadSavedMarkets(); }, []);
  useEffect(() => { loadManualMatches(); }, []);

  // Auto-refresh saved markets every 10s
  useEffect(() => {
    const iv = setInterval(() => loadSavedMarkets(), 10000);
    return () => clearInterval(iv);
  }, []);

  // Auto-fetch MarketFinder data when entering marketfinder view
  useEffect(() => {
    if (viewMode !== "marketfinder") return;

    const isCacheValid = mfCacheRef.current.fetchedAt > 0 && 
      (Date.now() - mfCacheRef.current.fetchedAt) < MF_CACHE_TTL_MS;

    if (isCacheValid && mfCacheRef.current.data.length > 0) {
      // Use cached data instantly
      setMfMarkets(mfCacheRef.current.data);
      // Still fetch fresh data in background
      fetchFreshMfMarkets(false);
    } else {
      fetchFreshMfMarkets(true);
    }
  }, [viewMode]);

  // Auto-refresh interval for MarketFinder (60s polling)
  useEffect(() => {
    if (viewMode !== "marketfinder") return;

    // Clear existing interval
    if (mfAutoRefreshRef.current !== null) {
      clearInterval(mfAutoRefreshRef.current);
      mfAutoRefreshRef.current = null;
    }

    if (!mfAutoRefreshEnabled) return;

    mfAutoRefreshRef.current = setInterval(() => {
      fetchFreshMfMarkets(false);
    }, 60000); // 60 seconds

    return () => {
      if (mfAutoRefreshRef.current !== null) {
        clearInterval(mfAutoRefreshRef.current);
        mfAutoRefreshRef.current = null;
      }
    };
  }, [viewMode, mfAutoRefreshEnabled]);

  // Polling timer
  useEffect(() => {
    const iv = setInterval(() => setPollTimer(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  // Persist selection to localStorage whenever it changes
  useEffect(() => {
    persistMfSelectedIds(mfSelectedIds);
  }, [mfSelectedIds]);

  // ── MF bulk selection helpers ──
  const toggleMfSelected = useCallback((id: string) => {
    setMfSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleMfSelectAll = useCallback((visibleIds: string[]) => {
    const allSelected = visibleIds.every(id => mfSelectedIds.has(id));
    setMfSelectedIds(prev => {
      const next = new Set(prev);
      if (allSelected) {
        visibleIds.forEach(id => next.delete(id));
      } else {
        visibleIds.forEach(id => next.add(id));
      }
      return next;
    });
  }, [mfSelectedIds]);

  // Bulk save selected markets
  const mfBulkSave = useCallback(async () => {
    if (mfSelectedIds.size === 0 || mfBulkSaving) return;
    setMfBulkSaving(true);
    setMfBulkMsg("");

    const toSave = mfMarkets.filter(m => mfSelectedIds.has(m.id) && m.kalshiUrl && m.polymarketUrl);
    let saved = 0;
    let failed = 0;

    for (const m of toSave) {
      try {
        const res = await fetch("/api/predictionhunt/markets?action=save-to-h2h", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kalshiUrl: m.kalshiUrl,
            polymarketUrl: m.polymarketUrl,
            title: m.title,
            category: m.eventType,
            expiryDate: m.eventDate || null,
          }),
        });
        const data = await res.json();
        if (data.success) {
          saved++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    // Clear selections for successfully saved markets
    setMfSelectedIds(prev => {
      const next = new Set(prev);
      toSave.forEach(m => next.delete(m.id));
      return next;
    });

    await loadSavedMarkets();
    setMfBulkSaving(false);

    if (failed > 0) {
      setMfBulkMsg(`${saved} saved, ${failed} failed`);
    } else {
      setMfBulkMsg(`${saved} market${saved !== 1 ? "s" : ""} saved to H2H`);
    }
    setTimeout(() => setMfBulkMsg(""), 3000);
  }, [mfSelectedIds, mfBulkSaving, mfMarkets]);

  /** Fetch fresh MF markets from API, optionally showing loading state */
  const fetchFreshMfMarkets = useCallback((showLoading: boolean) => {
    if (showLoading) setMfLoading(true);
    setMfError("");
    fetch("/api/predictionhunt/markets", { headers: { "Cache-Control": "no-store" } })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          const markets = d.markets || [];
          setMfMarkets(markets);
          setMfLastSync(d.lastSync);
          // Update cache
          mfCacheRef.current = { data: markets, fetchedAt: Date.now() };
        }
        setMfError("");
      })
      .catch(() => setMfError("Failed to load MarketFinder data"))
      .finally(() => { if (showLoading) setMfLoading(false); });
  }, []);

  // Cmd+Enter quick-save keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (viewMode === "marketfinder") {
          mfBulkSave();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewMode, mfBulkSave]);

  // Listen for spread threshold changes from MarketFinderPanel slider
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<number>;
      setMfSpreadThreshold(ce.detail);
    };
    window.addEventListener("mf-spread-change", handler);
    return () => window.removeEventListener("mf-spread-change", handler);
  }, []);

  // Toggle sidebar sort
  const toggleSidebarSort = (field: SidebarSort) => {
    if (sidebarSort === field) {
      setSidebarSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSidebarSort(field);
      setSidebarSortDir("asc");
    }
  };

  // Toggle overview sort
  const toggleOverviewSort = (field: OverviewSort) => {
    if (overviewSort === field) {
      setOverviewSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setOverviewSort(field);
      setOverviewSortDir(field === "expiry" ? "asc" : "desc");
    }
  };

  // Theme
  const theme = useTheme();

  // ── Render ──
  return (
    <div className="min-h-screen bg-[#121212] text-[#FFFFFF]">
      <ToastContainer toast={alertSystem.toast} />
      {alertSettingsOpen && <AlertSettingsPanel onClose={() => setAlertSettingsOpen(false)} alertSystem={alertSystem} />}

      {/* Top nav bar */}
      <header className="sticky top-0 z-50 border-b border-[#182533] bg-[#121212]/90 backdrop-blur">
        <div className="flex items-center h-14 px-4 gap-3">
          <button onClick={() => setMobileMenuOpen(v => !v)} className="lg:hidden p-2 rounded-lg hover:bg-[#182533]">
            <Rows3 className="w-5 h-5" />
          </button>
          <h1 className="text-base font-bold tracking-tight">H2H Arbitrage</h1>

          <div className="flex items-center gap-2 ml-4">
            <Filter className="w-4 h-4 text-[#5E6875]" />
            <select
              value={overviewCategory}
              onChange={(e) => setOverviewCategory(e.target.value)}
              className="px-2 py-1.5 rounded-lg bg-[#182533] border border-[#232E3C] text-xs text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
              title="Filter by category"
            >
              <option value="all">All categories</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
            </select>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setAlertSettingsOpen(true)} className="p-2 rounded-lg hover:bg-[#182533] text-[#5E6875] hover:text-[#FFFFFF]" title="Alert settings">
              <Bookmark className="w-4 h-4" />
            </button>
            <button onClick={() => theme.toggle()} className="p-2 rounded-lg hover:bg-[#182533] text-[#5E6875] hover:text-[#FFFFFF]" title="Toggle theme">
              {theme.isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      <main className="flex">
        <MarketSidebar
          markets={savedMarkets}
          activeId={activeMarketId}
          viewMode={viewMode}
          onSelectMarket={loadMarket}
          onEditMarket={() => {}}
          onDeleteMarket={(id) => { if (confirm("Delete market?")) deleteMarket(id); }}
          sort={overviewSort}
          sortDir={overviewSortDir}
          onToggleSort={toggleOverviewSort}
          timeUntilExpiry={timeUntilExpiry}
          layout={overviewLayout}
          onToggleLayout={setOverviewLayout}
          expiryFilter={overviewExpiryFilter}
          onSetExpiryFilter={setOverviewExpiryFilter}
          onScanAll={scanAllMarkets}
          scanningAll={scanningAll}
          scanAllError={scanAllError}
          onGoOverview={goToOverview}
          onGoScan={goToScan}
          onGoMarketFinder={goToMarketFinder}
        />
        <div className="flex-1 min-h-[calc(100vh-3.5rem)]">
          <div className="max-w-7xl mx-auto p-6">
            {viewMode === "overview" ? (
              <OverviewPanel
                markets={savedMarkets}
                loading={overviewLoading}
                onLoad={() => {
                  setOverviewLoading(true);
                  loadSavedMarkets().finally(() => setOverviewLoading(false));
                }}
                sort={overviewSort}
                sortDir={overviewSortDir}
                onToggleSort={toggleOverviewSort}
                layout={overviewLayout}
                onToggleLayout={setOverviewLayout}
                expiryFilter={overviewExpiryFilter}
                onSetExpiryFilter={setOverviewExpiryFilter}
                timeUntilExpiry={timeUntilExpiry}
                formatExpiry={formatExpiry}
              />
            ) : viewMode === "marketfinder" ? (
              <MarketFinderPanel
                markets={mfMarkets}
                savedMarketUrls={savedMarkets.map((m) => ({ kalshi: m.kalshiUrl || '', pm: m.polymarketUrl || '' }))}
                loading={mfLoading}
                syncing={mfSyncing}
                error={mfError}
                lastSync={mfLastSync}
                savingIds={mfSavingIds}
                selectedIds={mfSelectedIds}
                bulkSaving={mfBulkSaving}
                bulkMsg={mfBulkMsg}
                spreadThreshold={mfSpreadThreshold}
                category={mfCategory}
                autoRefreshEnabled={mfAutoRefreshEnabled}
                onFetch={() => {
                  fetchFreshMfMarkets(true);
                }}
                onSync={() => {
                  setMfSyncing(true);
                  setMfError("");
                  fetch("/api/predictionhunt/markets?action=sync", { method: "POST" })
                    .then((r) => r.json())
                    .then((d) => {
                      if (d.success) {
                        setMfLastSync(d.synced);
                        return fetch("/api/predictionhunt/markets", { headers: { "Cache-Control": "no-store" } })
                          .then((r) => r.json())
                          .then((d2) => {
                            if (d2.success) {
                              const markets = d2.markets || [];
                              setMfMarkets(markets);
                              setMfLastSync(d2.lastSync);
                              mfCacheRef.current = { data: markets, fetchedAt: Date.now() };
                            }
                          });
                      } else {
                        setMfError(d.error || "Sync failed");
                      }
                    })
                    .catch(() => setMfError("Sync request failed"))
                    .finally(() => setMfSyncing(false));
                }}
                onSaveToH2H={(m) => {
                  if (!m.kalshiUrl || !m.polymarketUrl) return;
                  setMfSavingIds((prev) => new Set(prev).add(m.id));
                  fetch("/api/predictionhunt/markets?action=save-to-h2h", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      kalshiUrl: m.kalshiUrl,
                      polymarketUrl: m.polymarketUrl,
                      title: m.title,
                      category: m.eventType,
                      expiryDate: m.eventDate || null,
                    }),
                  })
                    .then((r) => r.json())
                    .then((d) => {
                      if (!d.success) {
                        setMfError(d.error || "Failed to save");
                      } else {
                        loadSavedMarkets();
                      }
                    })
                    .catch(() => setMfError("Failed to save market"))
                    .finally(() => {
                      setMfSavingIds((prev) => {
                        const n = new Set(prev);
                        n.delete(m.id);
                        return n;
                      });
                    });
                }}
                onToggleSelected={toggleMfSelected}
                onToggleSelectAll={toggleMfSelectAll}
                onBulkSave={mfBulkSave}
                onSetCategories={setMfCategoriesUrl}
                onToggleAutoRefresh={(enabled) => {
                  setMfAutoRefreshEnabled(enabled);
                  persistMfAutoRefresh(enabled);
                }}
              />
            ) : (
              <>
                {/* Scan inputs */}
                {!activeMarketId && (
                <div className="rounded-xl border border-[#182533] bg-[#17212B] p-5 mb-6">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm font-medium text-[#8A9BA8]">
                        <Link2 className="w-4 h-4" /> Kalshi URL
                      </label>
                      <input type="text" value={kalshiUrl} onChange={(e) => setKalshiUrl(e.target.value)} className="w-full px-3 py-2.5 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] placeholder-[#232E3C] focus:outline-none focus:border-[#5DBE81] focus:ring-1 focus:ring-[#5DBE81]/30 transition-all" placeholder="https://kalshi.com/markets/..." />
                    </div>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm font-medium text-[#8A9BA8]">
                        <Link2 className="w-4 h-4" /> Polymarket URL
                      </label>
                      <input type="text" value={pmUrl} onChange={(e) => setPmUrl(e.target.value)} className="w-full px-3 py-2.5 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] placeholder-[#232E3C] focus:outline-none focus:border-[#5DBE81] focus:ring-1 focus:ring-[#5DBE81]/30 transition-all" placeholder="https://polymarket.com/event/..." />
                    </div>
                  </div>

                  <div className="flex items-center gap-3 flex-wrap">
                    <button onClick={() => handleScan(false)} disabled={loading} className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#5DBE81] text-black font-semibold text-sm hover:bg-[#4DA66E] transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scan className="w-4 h-4" />}
                      {loading ? "Scanning..." : "Scan Markets"}
                    </button>

                    {result && (
                      <button onClick={openSaveModal} disabled={saving} className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#182533] border border-[#232E3C] text-[#FFFFFF] text-sm hover:bg-[#232E3C] transition-all disabled:opacity-50">
                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        {saving ? "Saving..." : "Save Market"}
                      </button>
                    )}

                    <div className="flex items-center gap-2 ml-auto">
                      <label className="text-xs text-[#5E6875]">Capital:</label>
                      <input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))} className="w-24 px-2 py-1.5 rounded-md bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]" />
                    </div>
                  </div>

                  {error && (
                    <div className="mt-3 flex items-center gap-2 text-sm text-[#ef4444]">
                      <AlertCircle className="w-4 h-4" /> {error}
                    </div>
                  )}
                </div>
                )}

                {/* Results */}
                {result && (
                  <div className="space-y-4">
                    {activeMarketId && (
                      <div className="flex items-center gap-3 mb-2">
                        <h2 className="text-xl font-bold tracking-tight text-[#FFFFFF]">{result.eventTitle}</h2>
                        {savedMarkets.find(m => m.id === activeMarketId)?.category && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#182533] text-[#5E6875]">
                            {savedMarkets.find(m => m.id === activeMarketId)?.category}
                          </span>
                        )}
                      </div>
                    )}
                    {/* Compact stats + platform bar */}
                    <div className="flex items-stretch gap-2 mb-2">
                      {/* Platform box — ultra-compact (~29px, was ~48px, ~40% reduction) */}
                      <div className="rounded-md border border-[#182533] bg-[#17212B] p-1 flex items-center gap-1 shrink-0">
                        <a href={kalshiUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex flex-col items-center gap-0.5 rounded bg-[#5DBE81]/10 hover:bg-[#5DBE81]/20 transition-colors px-1.5 py-0.5" title="Kalshi">
                          <img src="/kalshi-icon.png" alt="" className="w-4 h-4 rounded-sm" />
                          <span className="text-[8px] font-semibold text-[#5DBE81] leading-none">K</span>
                        </a>
                        <a href={pmUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex flex-col items-center gap-0.5 rounded bg-[#a855f7]/10 hover:bg-[#a855f7]/20 transition-colors px-1.5 py-0.5" title="Polymarket">
                          <img src="/polymarket-icon.png" alt="" className="w-4 h-4 rounded-sm" />
                          <span className="text-[8px] font-semibold text-[#a855f7] leading-none">PM</span>
                        </a>
                        {activeMarketId && (
                          <button
                            onClick={() => {
                              const market = savedMarkets.find(m => m.id === activeMarketId);
                              if (market) handleScanWithUrls(market.kalshiUrl, market.polymarketUrl);
                            }}
                            disabled={loading}
                            className="flex items-center justify-center rounded bg-[#232E3C] text-[#5E6875] hover:text-[#FFFFFF] hover:bg-[#232E3C] transition-colors disabled:opacity-50 px-1.5 py-0.5"
                            title="Refresh"
                          >
                            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                          </button>
                        )}
                      </div>
                      {/* Stat cards — ultra-compact to match platform bar */}
                      <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                        <StatCard label="Kalshi" value={result.kalshiCount} icon={<Activity className="w-3 h-3" />} color="blue" compact />
                        <StatCard label="Polymarket" value={result.pmCount} icon={<Activity className="w-3 h-3" />} color="purple" compact />
                        <StatCard label="Matched" value={result.matchedCount} icon={<Link2 className="w-3 h-3" />} color="green" compact />
                        <StatCard label="Expiry" value={formatExpiry(result.expiryDate)} icon={<Calendar className="w-3 h-3" />} color="yellow" compact />
                      </div>
                    </div>

                    {(result.kalshiCount === 0 || result.pmCount === 0 || result.matchedCount === 0) && (
                      <div className="rounded-xl border border-[#facc15]/30 bg-[#facc15]/10 p-3 flex items-start gap-3 text-sm text-[#facc15]">
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <div className="space-y-1">
                          <div className="font-semibold">Market data warning</div>
                          <div className="text-xs text-[#8A9BA8]">
                            {result.kalshiCount === 0 && <span className="mr-3">Kalshi returned 0 open markets.</span>}
                            {result.pmCount === 0 && <span className="mr-3">Polymarket returned 0 markets.</span>}
                            {result.kalshiCount > 0 && result.pmCount > 0 && result.matchedCount === 0 && <span className="mr-3">No matched pairs found. Manual matching may be needed.</span>}
                          </div>
                          <div className="text-[11px] text-[#8A9BA8]">
                            Raw: K {result.kalshiRawCount ?? result.kalshiCount} / PM {result.pmRawCount ?? result.pmCount}; PM filtered {result.pmFilteredCount ?? result.pmCount}; Kalshi source {result.kalshiFetchSource ?? "unknown"}; CLOB {result.clobHitCount ?? 0} hit / {result.clobMissCount ?? 0} miss
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Coupling suggestions for unmatched markets */}
                    {result.unmatchedKalshi.length > 0 && result.unmatchedPolymarket.length > 0 && (
                      <CouplingSuggestions
                        unmatchedKalshi={result.unmatchedKalshi}
                        unmatchedPolymarket={result.unmatchedPolymarket}
                        expiryDate={result.expiryDate}
                        category={activeMarketId ? savedMarkets.find(m => m.id === activeMarketId)?.category : undefined}
                        onAccept={(kalshiTicker, pmConditionId) => {
                          const km = result.unmatchedKalshi.find(k => k.ticker === kalshiTicker);
                          const pm = result.unmatchedPolymarket.find(p => p.conditionId === pmConditionId);
                          if (km && pm) {
                            onCreateMatch(kalshiTicker, pmConditionId, km.title, pm.title);
                          }
                        }}
                      />
                    )}

                    {/* View toggle: outcome table <-> 1on1 bookmaker view */}
                    {result.matchedCount > 0 && (
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setBookmakerView(false)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              !bookmakerView
                                ? "bg-[#5DBE81]/15 text-[#5DBE81] ring-1 ring-[#5DBE81]/30"
                                : "bg-[#182533] text-[#5E6875] hover:text-[#FFFFFF]"
                            }`}
                          >
                            <Rows3 className="w-3.5 h-3.5" /> Outcomes Table
                          </button>
                          <button
                            onClick={() => setBookmakerView(true)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              bookmakerView
                                ? "bg-[#5DBE81]/15 text-[#5DBE81] ring-1 ring-[#5DBE81]/30"
                                : "bg-[#182533] text-[#5E6875] hover:text-[#FFFFFF]"
                            }`}
                          >
                            <BarChart3 className="w-3.5 h-3.5" /> 1on1 Bookmaker
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Bookmaker 1on1 view */}
                    {result && bookmakerView && (
                      <Bookmaker1on1
                        outcomes={result.allOutcomes.map(o => ({
                          artist: o.artist,
                          kalshi: o.kalshi ? {
                            yesBid: o.kalshi.yesBid,
                            yesAsk: o.kalshi.yesAsk,
                            noBid: o.kalshi.noBid,
                            noAsk: o.kalshi.noAsk,
                            lastPrice: o.kalshi.lastPrice,
                          } : null,
                          polymarket: o.polymarket ? {
                            yesPrice: o.polymarket.yesPrice,
                            noPrice: o.polymarket.noPrice,
                            bestBid: o.polymarket.bestBid,
                            bestAsk: o.polymarket.bestAsk,
                            lastTradePrice: o.polymarket.lastTradePrice,
                          } : null,
                        }))}
                        lastUpdated={lastUpdated}
                      />
                    )}

                    {/* Outcome table — expanded log/detail area */}
                    {!bookmakerView && result.matchedCount > 0 && (
                      <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-[#17212B] border-b border-[#182533]">
                            <tr className="text-[10px] text-[#5E6875] uppercase tracking-wider">
                              <th className="text-left px-4 py-3.5 font-medium">Outcome</th>
                              <th className="text-right px-4 py-3.5 font-medium">Kalshi Yes</th>
                              <th className="text-right px-4 py-3.5 font-medium">PM Yes</th>
                              <th className="text-right px-4 py-3.5 font-medium">Spread</th>
                              <th className="text-right px-4 py-3.5 font-medium">ROI</th>
                              <th className="text-right px-4 py-3.5 font-medium">Profit</th>
                              <th className="text-right px-4 py-3.5 font-medium">Stake</th>
                              <th className="text-left px-4 py-3.5 font-medium">Strategy</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#182533]">
                            <OutcomeTableBody
                              outcomes={result.allOutcomes}
                              expandedArtist={expandedArtist}
                              setExpandedArtist={setExpandedArtist}
                              formatCurrency={formatCurrency}
                              formatPercent={formatPercent}
                            />
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Embedded platform browsers */}
                    <DualBrowserPanels
                      kalshiUrl={kalshiUrl}
                      pmUrl={pmUrl}
                      layout={panelLayout}
                      onLayoutChange={setPanelLayout}
                      refreshTrigger={embedRefreshCounter}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>

      {/* Save modal */}
      {saveModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setSaveModalOpen(false)}>
          <div className="bg-[#17212B] border border-[#182533] rounded-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">Save Market</h3>
            <p className="text-sm text-[#5E6875] mb-4">This will add the scanned market pair to your saved markets list.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setSaveModalOpen(false)} className="px-4 py-2 rounded-lg bg-[#182533] text-sm hover:bg-[#232E3C] transition-colors">Cancel</button>
              <button onClick={saveMarket} disabled={saving} className="px-4 py-2 rounded-lg bg-[#5DBE81] text-black text-sm font-semibold hover:bg-[#4DA66E] transition-colors disabled:opacity-50">
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editModalOpen && editingMarket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setEditModalOpen(false)}>
          <div className="bg-[#17212B] border border-[#182533] rounded-xl p-6 w-full max-w-md mx-4 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Edit Market</h3>
            <div>
              <label className="text-xs text-[#5E6875] block mb-1">Title</label>
              <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="w-full px-3 py-2 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]" />
            </div>
            <div>
              <label className="text-xs text-[#5E6875] block mb-1">Category</label>
              <input type="text" value={editCategory} onChange={(e) => setEditCategory(e.target.value)} className="w-full px-3 py-2 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]" placeholder="e.g. Politics, Crypto..." />
            </div>
            <div>
              <label className="text-xs text-[#5E6875] block mb-1">Expiry date</label>
              <input type="date" value={editExpiry} onChange={(e) => setEditExpiry(e.target.value)} className="w-full px-3 py-2 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditModalOpen(false)} className="px-4 py-2 rounded-lg bg-[#182533] text-sm hover:bg-[#232E3C] transition-colors">Cancel</button>
              <button onClick={saveEdit} disabled={saving} className="px-4 py-2 rounded-lg bg-[#5DBE81] text-black text-sm font-semibold hover:bg-[#4DA66E] transition-colors disabled:opacity-50">
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Market Sidebar ── */
function MarketSidebar({
  markets,
  activeId,
  viewMode,
  onSelectMarket,
  onEditMarket,
  onDeleteMarket,
  sort,
  sortDir,
  onToggleSort,
  timeUntilExpiry,
  layout,
  onToggleLayout,
  expiryFilter,
  onSetExpiryFilter,
  onScanAll,
  scanningAll,
  scanAllError,
  onGoOverview,
  onGoScan,
  onGoMarketFinder,
}: {
  markets: SavedMarket[];
  activeId: string | null;
  viewMode: string;
  onSelectMarket: (m: SavedMarket) => void;
  onEditMarket: (m: SavedMarket) => void;
  onDeleteMarket: (id: string) => void;
  sort: OverviewSort;
  sortDir: "asc" | "desc";
  onToggleSort: (f: OverviewSort) => void;
  timeUntilExpiry: (iso?: string | null) => string;
  layout: "grid" | "table";
  onToggleLayout: (l: "grid" | "table") => void;
  expiryFilter: "all" | "lte7" | "lte14" | "lte30";
  onSetExpiryFilter: (f: "all" | "lte7" | "lte14" | "lte30") => void;
  onScanAll: () => void;
  scanningAll: boolean;
  scanAllError: string;
  onGoOverview: () => void;
  onGoScan: () => void;
  onGoMarketFinder: () => void;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSearch, setSidebarSearch] = useState("");

  // Filter + sort
  const filtered = markets.filter(m => {
    if (expiryFilter !== "all") {
      if (!m.expiryDate) return true;
      const days = (new Date(m.expiryDate).getTime() - Date.now()) / 86400000;
      if (expiryFilter === "lte7" && days > 7) return false;
      if (expiryFilter === "lte14" && days > 14) return false;
      if (expiryFilter === "lte30" && days > 30) return false;
    }
    if (sidebarSearch && !m.eventTitle.toLowerCase().includes(sidebarSearch.toLowerCase())) return false;
    return true;
  }).sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sort === "name") return mul * a.eventTitle.localeCompare(b.eventTitle);
    if (sort === "expiry") {
      const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
      const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
      return mul * (ea - eb);
    }
    if (sort === "roi") {
      const ra = a.lastScanResult?.bestRoiPct ?? 0;
      const rb = b.lastScanResult?.bestRoiPct ?? 0;
      return mul * (rb - ra);
    }
    if (sort === "apy") {
      const aa = a.lastScanResult?.bestRoiPct ?? 0;
      const ab = b.lastScanResult?.bestRoiPct ?? 0;
      return mul * (ab - aa);
    }
    return 0;
  });

  return (
    <aside className={`${sidebarOpen ? "w-72" : "w-0"} shrink-0 border-r border-[#182533] bg-[#17212B] overflow-hidden transition-all duration-200`}>
      <div className="p-4 space-y-4 h-full flex flex-col">
        {/* ── Navigation (moved from header) ── */}
        <div className="space-y-1">
          <button onClick={onGoOverview} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${viewMode === "overview" ? "bg-[#5DBE81]/10 text-[#5DBE81]" : "bg-[#182533] text-[#8A9BA8] hover:bg-[#232E3C] hover:text-[#FFFFFF]"}`}>
            <BarChart3 className="w-4 h-4" />
            Overview
          </button>
          <button onClick={onGoScan} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${viewMode === "scan" ? "bg-[#5DBE81]/10 text-[#5DBE81]" : "bg-[#182533] text-[#8A9BA8] hover:bg-[#232E3C] hover:text-[#FFFFFF]"}`}>
            <Scan className="w-4 h-4" />
            Scan
          </button>
          <button onClick={onGoMarketFinder} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${viewMode === "marketfinder" ? "bg-[#5DBE81]/10 text-[#5DBE81]" : "bg-[#182533] text-[#8A9BA8] hover:bg-[#232E3C] hover:text-[#FFFFFF]"}`}>
            <Globe className="w-4 h-4" />
            MarketFinder
          </button>
        </div>

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-[#FFFFFF]">Saved Markets ({markets.length})</h2>
          <div className="flex items-center gap-1">
            <button onClick={onScanAll} disabled={scanningAll} className="p-1.5 rounded-md hover:bg-[#182533] text-[#5E6875] hover:text-[#5DBE81] transition-colors disabled:opacity-50" title="Scan All">
              {scanningAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {scanAllError && <div className="text-xs text-[#ef4444]">{scanAllError}</div>}

        {/* Filters */}
        <div className="space-y-2">
          <input
            type="text"
            value={sidebarSearch}
            onChange={(e) => setSidebarSearch(e.target.value)}
            placeholder="Search markets..."
            className="w-full px-2 py-1.5 rounded-md bg-[#182533] border border-[#232E3C] text-xs text-[#FFFFFF] placeholder-[#232E3C] focus:outline-none focus:border-[#5DBE81]"
          />
          <div className="flex items-center gap-1">
            <select
              value={expiryFilter}
              onChange={(e) => onSetExpiryFilter(e.target.value as any)}
              className="px-2 py-1 rounded-md bg-[#182533] border border-[#232E3C] text-xs text-[#FFFFFF] focus:outline-none"
            >
              <option value="all">All expiries</option>
              <option value="lte7">≤ 7 days</option>
              <option value="lte14">≤ 14 days</option>
              <option value="lte30">≤ 30 days</option>
            </select>
          </div>
        </div>

        {/* Market list */}
        <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
          {filtered.map((m) => {
            const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
            const isActive = activeId === m.id;
            return (
              <div
                key={m.id}
                onClick={() => onSelectMarket(m)}
                className={`flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors ${
                  isActive ? "bg-[#5DBE81]/10 ring-1 ring-[#5DBE81]/30" : "hover:bg-[#182533]"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-[#FFFFFF] truncate">{m.eventTitle}</div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {m.category && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#182533] text-[#5E6875]">{m.category}</span>
                    )}
                    <span className="text-[9px] text-[#5E6875]">{timeUntilExpiry(m.expiryDate)}</span>
                  </div>
                </div>
                {roi !== 0 && (
                  <span className={`text-xs font-bold ${roi > 0 ? "text-[#5DBE81]" : "text-[#ef4444]"}`}>
                    {roi > 0 ? "+" : ""}{formatPercent(roi)}
                  </span>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && markets.length > 0 && (
            <div className="text-xs text-[#232E3C] text-center py-4">No markets match filters.</div>
          )}
          {markets.length === 0 && (
            <div className="text-xs text-[#232E3C] text-center py-4">No saved markets yet.</div>
          )}
        </div>
      </div>
    </aside>
  );
}

/* ── Overview Panel ── */
function OverviewPanel({
  markets,
  loading,
  onLoad,
  sort,
  sortDir,
  onToggleSort,
  layout,
  onToggleLayout,
  expiryFilter,
  onSetExpiryFilter,
  timeUntilExpiry,
  formatExpiry,
}: {
  markets: SavedMarket[];
  loading: boolean;
  onLoad: () => void;
  sort: OverviewSort;
  sortDir: "asc" | "desc";
  onToggleSort: (f: OverviewSort) => void;
  layout: "grid" | "table";
  onToggleLayout: (l: "grid" | "table") => void;
  expiryFilter: "all" | "lte7" | "lte14" | "lte30";
  onSetExpiryFilter: (f: "all" | "lte7" | "lte14" | "lte30") => void;
  timeUntilExpiry: (iso?: string | null) => string;
  formatExpiry: (iso?: string | null) => string;
}) {
  // Auto-load on mount only — prevents infinite loop if parent re-creates callback
  useEffect(() => { onLoad(); }, []);

  const sortFn = (a: SavedMarket, b: SavedMarket) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sort === "name") return mul * a.eventTitle.localeCompare(b.eventTitle);
    if (sort === "expiry") {
      const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
      const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
      return mul * (ea - eb);
    }
    if (sort === "roi") {
      const ra = a.liveResult?.bestRoiPct ?? a.lastScanResult?.bestRoiPct ?? 0;
      const rb = b.liveResult?.bestRoiPct ?? b.lastScanResult?.bestRoiPct ?? 0;
      return mul * (rb - ra);
    }
    return 0;
  };

  const sorted = [...markets].sort(sortFn);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold tracking-tight">Overview</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => onToggleLayout(layout === "grid" ? "table" : "grid")} className="p-2 rounded-lg bg-[#182533] hover:bg-[#232E3C] text-[#5E6875] transition-colors" title="Toggle layout">
            {layout === "grid" ? <Rows3 className="w-4 h-4" /> : <LayoutGrid className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-20 text-center text-sm text-[#5E6875]">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
          Loading markets...
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-20 text-center text-sm text-[#232E3C]">
          No saved markets. Go to Scan or MarketFinder to add some.
        </div>
      ) : layout === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {sorted.map((m) => {
            const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
            const profit = m.liveResult?.bestProfit ?? m.lastScanResult?.bestProfit ?? 0;
            const allArbs = m.liveResult?.allArbs ?? m.lastScanResult?.allArbs;
            return (
              <div key={m.id} className="rounded-xl border border-[#182533] bg-[#17212B] p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <h3 className="font-semibold text-sm text-[#FFFFFF]">{m.eventTitle}</h3>
                  {m.category && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#182533] text-[#5E6875]">{m.category}</span>}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="text-[#5E6875]">Expiry</div>
                  <div className="text-[#FFFFFF] text-right">{formatExpiry(m.expiryDate)}</div>
                  <div className="text-[#5E6875]">Best ROI</div>
                  <div className={`text-right font-bold ${roi > 0 ? "text-[#5DBE81]" : roi < 0 ? "text-[#ef4444]" : "text-[#5E6875]"}`}>
                    {roi !== 0 ? `${roi > 0 ? "+" : ""}${formatPercent(roi)}` : "—"}
                  </div>
                  <div className="text-[#5E6875]">Est. Profit</div>
                  <div className="text-[#FFFFFF] text-right">{profit !== 0 ? formatProfitDisplay(profit, allArbs) : "—"}</div>
                </div>
                <div className="flex items-center gap-1 text-[10px] text-[#232E3C]">
                  <Clock className="w-3 h-3" />
                  {timeUntilExpiry(m.expiryDate)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#17212B] border-b border-[#182533]">
              <tr className="text-[10px] text-[#5E6875] uppercase tracking-wider">
                <th className="text-left px-4 py-3 font-medium">Market</th>
                <th className="text-right px-4 py-3 font-medium">Expiry</th>
                <th className="text-right px-4 py-3 font-medium">ROI</th>
                <th className="text-right px-4 py-3 font-medium">Profit</th>
                <th className="text-left px-4 py-3 font-medium">Strategy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#182533]">
              {sorted.map((m) => {
                const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
                const profit = m.liveResult?.bestProfit ?? m.lastScanResult?.bestProfit ?? 0;
                const allArbs = m.liveResult?.allArbs ?? m.lastScanResult?.allArbs;
                const strategy = m.liveResult?.strategy ?? m.lastScanResult?.strategy ?? "";
                return (
                  <tr key={m.id} className="hover:bg-[#182533]/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-[#FFFFFF]">{m.eventTitle}</td>
                    <td className="px-4 py-3 text-right text-[#FFFFFF]">{formatExpiry(m.expiryDate)}</td>
                    <td className={`px-4 py-3 text-right font-bold ${roi > 0 ? "text-[#5DBE81]" : roi < 0 ? "text-[#ef4444]" : "text-[#5E6875]"}`}>
                      {roi !== 0 ? `${roi > 0 ? "+" : ""}${formatPercent(roi)}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-[#FFFFFF]">{profit !== 0 ? formatProfitDisplay(profit, allArbs) : "—"}</td>
                    <td className="px-4 py-3 text-xs text-[#8A9BA8]">{strategy || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── MarketFinder Panel ── */
function MarketFinderPanel({
  markets,
  savedMarketUrls,
  loading,
  syncing,
  error,
  lastSync,
  savingIds,
  selectedIds,
  bulkSaving,
  bulkMsg,
  spreadThreshold,
  categories,
  autoRefreshEnabled,
  onFetch,
  onSync,
  onSaveToH2H,
  onToggleSelected,
  onToggleSelectAll,
  onBulkSave,
  onSetCategories,
  onToggleAutoRefresh,
}: {
  markets: any[];
  savedMarketUrls: { kalshi: string; pm: string }[];
  loading: boolean;
  syncing: boolean;
  error: string;
  lastSync: any;
  savingIds: Set<string>;
  selectedIds: Set<string>;
  bulkSaving: boolean;
  bulkMsg: string;
  spreadThreshold: number;
  categories: string[];
  autoRefreshEnabled: boolean;
  onFetch: () => void;
  onSync: () => void;
  onSaveToH2H: (m: any) => void;
  onToggleSelected: (id: string) => void;
  onToggleSelectAll: (visibleIds: string[]) => void;
  onBulkSave: () => void;
  onSetCategories: (cats: string[]) => void;
  onToggleAutoRefresh: (enabled: boolean) => void;
}) {
  // Parent handles auto-fetch via viewMode effect; this just fetches on first mount
  const [hasFetched, setHasFetched] = useState(false);
  useEffect(() => {
    if (!hasFetched) {
      onFetch();
      setHasFetched(true);
    }
  }, [hasFetched, onFetch]);

  // Local spread threshold (defaults to prop, user-adjustable via slider)
  const [localThreshold, setLocalThreshold] = useState(spreadThreshold);

  const normalized = (url: string) => (url || '').split('?')[0].replace(/\/$/, '').toLowerCase();
  const filtered = markets.filter((m) => {
    const kUrl = normalized(m.kalshiUrl);
    const pmUrl = normalized(m.polymarketUrl);
    if (!kUrl && !pmUrl) return false;
    return !savedMarketUrls.some(
      (saved) => (kUrl && normalized(saved.kalshi) === kUrl) || (pmUrl && normalized(saved.pm) === pmUrl)
    );
  });

  // Category filter (only applied after excluding saved markets)
  const categoryFiltered = categories.length > 0
    ? filtered.filter(m => categories.includes(m.eventType))
    : filtered;

  // Sort: markets with spread < threshold first (ascending), then by spread descending, then by expiry
  const sorted = categoryFiltered.sort((a, b) => {
    const aBelow = a.spreadPct != null && a.spreadPct <= localThreshold;
    const bBelow = b.spreadPct != null && b.spreadPct <= localThreshold;
    // Below-threshold markets come first
    if (aBelow !== bBelow) return aBelow ? -1 : 1;
    // Within same tier, sort by spread ascending
    if (a.spreadPct != null && b.spreadPct != null) {
      return a.spreadPct - b.spreadPct;
    }
    // Markets without spread go to bottom, sorted by expiry
    const da = a.eventDate ? new Date(a.eventDate).getTime() : Infinity;
    const db = b.eventDate ? new Date(b.eventDate).getTime() : Infinity;
    return da - db;
  });

  const visibleIds = sorted.map(m => m.id);
  const selectedVisibleCount = visibleIds.filter(id => selectedIds.has(id)).length;
  const allSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const indeterminate = selectedVisibleCount > 0 && !allSelected;

  const hiddenCount = markets.length - sorted.length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Globe className="w-5 h-5 text-[#5DBE81]" />
            MarketFinder
          </h2>
          <p className="text-xs text-[#5E6875] mt-0.5">
            PredictionHunt matched markets — sorted by spread ({spreadThreshold}% threshold)
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastSync && (
            <span className="text-[10px] text-[#232E3C]">
              Last sync: {getTimeAgo(lastSync.finishedAt || lastSync.startedAt)}
            </span>
          )}
          <button
            onClick={onSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#5DBE81]/10 text-[#5DBE81] text-sm font-medium hover:bg-[#5DBE81]/20 transition-all border border-[#5DBE81]/20 disabled:opacity-50"
          >
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {syncing ? "Syncing..." : "Sync All"}
          </button>
        </div>
      </div>

      {/* Spread threshold control */}
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#182533]/50 border border-[#232E3C]">
        <Filter className="w-3.5 h-3.5 text-[#5E6875]" />
        <span className="text-xs text-[#5E6875]">Spread threshold:</span>
        <input
          type="range"
          min="1"
          max="50"
          step="0.5"
          value={spreadThreshold}
          onChange={(e) => window.dispatchEvent(new CustomEvent('mf-spread-change', { detail: Number(e.target.value) }))}
          className="flex-1 accent-[#5DBE81] h-1"
        />
        <span className="text-xs font-mono text-[#5DBE81] min-w-[3rem] text-right">{spreadThreshold}%</span>
      </div>

      {/* Category filter — multi-select chips */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-[#182533]/50 border border-[#232E3C]">
        <Filter className="w-3.5 h-3.5 text-[#5E6875] shrink-0" />
        <span className="text-xs text-[#5E6875]">Category:</span>
        {CATEGORIES.map(c => {
          const isActive = categories.includes(c);
          return (
            <button
              key={c}
              onClick={() => {
                if (isActive) {
                  onSetCategories(categories.filter(x => x !== c));
                } else {
                  onSetCategories([...categories, c]);
                }
              }}
              className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition-all border ${
                isActive
                  ? "bg-[#5DBE81]/15 text-[#5DBE81] border-[#5DBE81]/30"
                  : "bg-[#182533] text-[#5E6875] border-[#232E3C] hover:text-[#8A9BA8] hover:border-[#232E3C]"
              }`}
            >
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </button>
          );
        })}
        {categories.length > 0 && (
          <button
            onClick={() => onSetCategories([])}
            className="px-2 py-0.5 rounded-full text-[11px] text-[#232E3C] hover:text-[#8A9BA8] transition-colors"
          >
            Clear
          </button>
        )}
        {categories.length > 0 && (
          <span className="text-[10px] text-[#232E3C] ml-auto">
            {sorted.length} of {filtered.length} markets
          </span>
        )}
      </div>

      {hiddenCount > 0 && (
        <div className="text-xs text-[#5E6875] flex items-center gap-2 px-3 py-2 rounded-lg bg-[#182533]/50">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[#5DBE81]"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          {hiddenCount} market{hiddenCount !== 1 ? 's' : ''} hidden (already in H2H)
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-[#ef4444]">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {bulkMsg && (
        <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${bulkMsg.includes("failed") ? "text-[#facc15] bg-[#facc15]/10" : "text-[#5DBE81] bg-[#5DBE81]/10"}`}>
          <Check className="w-4 h-4" /> {bulkMsg}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
          {/* Skeleton rows */}
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-[#182533] last:border-0 animate-pulse">
              <div className="w-3.5 h-3.5 rounded bg-[#232E3C] shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-48 rounded bg-[#232E3C]" />
                <div className="h-3 w-16 rounded bg-[#182533]" />
              </div>
              <div className="h-4 w-24 rounded bg-[#232E3C]" />
              <div className="h-4 w-20 rounded bg-[#232E3C]" />
              <div className="h-4 w-20 rounded bg-[#232E3C]" />
              <div className="h-8 w-24 rounded bg-[#232E3C]" />
            </div>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-20 text-center text-sm text-[#232E3C]">
          No markets found. Try syncing to fetch from PredictionHunt.
        </div>
      ) : (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
          {/* Bulk action bar */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#182533] bg-[#17212B]">
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#5E6875]">
                {selectedVisibleCount}/{sorted.length} selected
              </span>
              {selectedVisibleCount > 0 && (
                <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-[#182533] text-[#232E3C] border border-[#232E3C]">⌘↵</kbd>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onBulkSave()}
                disabled={bulkSaving || selectedVisibleCount === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#5DBE81]/10 text-[#5DBE81] text-xs font-medium hover:bg-[#5DBE81]/20 transition-all border border-[#5DBE81]/20 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {bulkSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {bulkSaving ? "Saving..." : `Save Selected (${selectedVisibleCount})`}
              </button>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead className="bg-[#17212B] border-b border-[#182533]">
              <tr className="text-[10px] text-[#5E6875] uppercase tracking-wider">
                <th className="px-4 py-3 font-medium w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={cb => { if (cb) cb.indeterminate = indeterminate; }}
                    onChange={() => onToggleSelectAll(visibleIds)}
                    className="w-3.5 h-3.5 rounded border-[#232E3C] bg-[#182533] text-[#5DBE81] focus:ring-[#5DBE81]/30 focus:ring-offset-0 cursor-pointer"
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium">Market</th>
                <th className="text-left px-4 py-3 font-medium w-40">Expiry</th>
                <th className="text-right px-4 py-3 font-medium w-20">Spread</th>
                <th className="text-left px-4 py-3 font-medium w-24"></th>
                <th className="text-left px-4 py-3 font-medium w-24"></th>
                <th className="text-center px-4 py-3 font-medium w-32"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#182533]">
              {sorted.map((m) => {
                const isSaving = savingIds.has(m.id);
                const isChecked = selectedIds.has(m.id);
                const spread = m.spreadPct;
                const spreadClass = spread != null
                  ? spread <= spreadThreshold ? "text-[#5DBE81]" : "text-[#facc15]"
                  : "text-[#232E3C]";
                return (
                  <tr key={m.id} className={`hover:bg-[#182533]/50 transition-colors ${isChecked ? "bg-[#5DBE81]/5" : ""}`}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => onToggleSelected(m.id)}
                        className="w-3.5 h-3.5 rounded border-[#232E3C] bg-[#182533] text-[#5DBE81] focus:ring-[#5DBE81]/30 focus:ring-offset-0 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#FFFFFF] text-sm">{m.title}</div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-[#182533] text-[#5E6875]">{m.eventType}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-[#FFFFFF]">
                        {m.eventDate ? new Date(m.eventDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : "—"}
                      </div>
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-xs ${spreadClass}`}>
                      {spread != null ? `${spread.toFixed(1)}%` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {m.kalshiUrl ? (
                        <a href={m.kalshiUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-[#facc15] hover:underline">Kalshi →</a>
                      ) : (
                        <span className="text-xs text-[#232E3C]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {m.polymarketUrl ? (
                        <a href={m.polymarketUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-[#5DBE81] hover:underline">Polymarket →</a>
                      ) : (
                        <span className="text-xs text-[#232E3C]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {isSaving ? (
                        <span className="inline-flex items-center gap-1 text-xs text-[#5E6875]">
                          <Loader2 className="w-3 h-3 animate-spin" /> Saving
                        </span>
                      ) : (
                        <button
                          onClick={() => onSaveToH2H(m)}
                          disabled={!m.kalshiUrl || !m.polymarketUrl}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[#5DBE81]/10 text-[#5DBE81] hover:bg-[#5DBE81]/20 transition-colors border border-[#5DBE81]/20 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          Add to H2H
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function getTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
