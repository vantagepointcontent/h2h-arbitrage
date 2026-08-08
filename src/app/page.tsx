"use client";

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
  Bell,
  Plus,
  BarChart3,
  LayoutDashboard,
  Layers,
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
  DollarSign,
  Hash,
  PanelRight,
  FileText,
  PanelLeft,
  Radar,
  GitMerge,
  Settings as SettingsIconLucide,
} from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
// UI-005: code-split heavy view components — only load when needed
const AlertSettingsPanel = dynamic(() => import("@/components/AlertSystem").then(m => m.AlertSettingsPanel), { ssr: false });
import { CATEGORIES } from "@/lib/categories";

import dynamic from "next/dynamic";
// PERF-P1: lazy-load heavy conditionally-rendered components into separate chunks
const Bookmaker1on1 = dynamic(() => import("@/app/components/Bookmaker1on1").then(m => m.Bookmaker1on1), {
  loading: () => <div className="p-4 text-sm text-[var(--text-secondary)]">Loading...</div>,
  ssr: false,
});
const CouplingSuggestions = dynamic(() => import("@/app/components/CouplingSuggestions").then(m => m.CouplingSuggestions), {
  loading: () => <div className="p-4 text-sm text-[var(--text-secondary)]">Loading...</div>,
  ssr: false,
});
const CoupleManagementPanel = dynamic(() => import("@/app/components/CoupleManagementPanel"), { ssr: false });
const DashboardPanel = dynamic(() => import("@/app/components/DashboardPanel"), { ssr: false });
const ArbTimingPanel = dynamic(() => import("@/app/components/ArbTimingPanel"), { ssr: false });
const LiveScanPanel = dynamic(() => import("@/app/components/LiveScanPanel"), { ssr: false });
const LogsPanel = dynamic(() => import("@/app/components/LogsPanel"), { ssr: false });
const SettingsPanel = dynamic(() => import("@/app/components/SettingsPanel"), { ssr: false });
const CouplingPanel = dynamic(() => import("@/app/components/CouplingPanel"), { ssr: false });
const ManualMatchPanel = dynamic(() => import("@/app/components/ManualMatchPanel"), { ssr: false });
const ScanCategoryPicker = dynamic(() => import("@/app/components/ScanCategoryPicker"), { ssr: false });
const TradesPanel = dynamic(() => import("@/app/components/TradesPanel"), { ssr: false });
const PhantomsPanel = dynamic(() => import("@/app/components/PhantomsPanel"), { ssr: false });
const ExecutionModeBadge = dynamic(() => import("@/app/components/ExecutionModeBadge"), { ssr: false });
const StakeCalculator = dynamic(() => import("@/components/StakeCalculator").then(m => m.StakeCalculator), { ssr: false });
const MarketEditPanel = dynamic(() => import("@/app/components/MarketEditPanel"), { ssr: false });
import { OutcomeTableBody } from "@/app/components/OutcomeTableBody";
import { ArbOpportunitiesPanel } from "@/app/components/ArbOpportunitiesPanel";
import { ApyHeaderInfo, HeaderInfo } from "@/app/components/ApyTooltip";
const HistoricalSpreadChart = dynamic(() => import("@/app/components/HistoricalSpreadChart").then(m => m.HistoricalSpreadChart), { ssr: false });
import { saveSpread } from "@/lib/spreadHistory";


import { MarketSidebar } from "@/app/components/MarketSidebar";
import { PlatformLinkInputs, type PlatformLinkInput } from "@/app/components/PlatformLinkInputs";
// UI-005: code-split heavy view panels
const OverviewPanel = dynamic(() => import("@/app/components/OverviewPanel").then(m => m.OverviewPanel), { ssr: false });
const MarketFinderPanel = dynamic(() => import("@/app/components/MarketFinderPanel").then(m => m.MarketFinderPanel), { ssr: false });
import {
  getStoredMfCategories, persistMfCategories, getStoredMfExpiryDays, persistMfExpiryDays,
  getStoredMfSelectedIds, persistMfSelectedIds, getStoredFavoriteIds, persistFavoriteIds,
  getStoredCustomTitles, setCustomTitle,
  removeCustomTitle, MAX_CUSTOM_TITLE_LEN, getStoredMfAutoRefresh, persistMfAutoRefresh,
  getStoredSidebarOpen, persistSidebarOpen, getTotalProfitFromOutcomes, isMatched,
  formatCurrency, formatPercent, formatExpiry, timeUntilExpiry, isMarketExpired, summarizeScanForSidebar,
  DEFAULT_MARKET_EXPIRY_FILTER, DEFAULT_SHOW_ARB_ONLY,
} from "@/app/lib/page-shared";
import type {
  ArbitrageInfo, UnifiedOutcome, UnmatchedKalshi, UnmatchedPolymarket,
  ManualMatch, LastScanResult, SavedMarket, ScanResult, OverviewSort,
} from "@/app/lib/page-shared";


/* ── Swipe gesture hook (Home-only) ── */
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

/**
 * Build a ScanResult from cached allArbs data (from lastScanResult/liveResult).
 * Populates kalshi and polymarket price fields so the detail view shows
 * cached prices immediately instead of "—" while a background refresh runs.
 */
function buildCachedResult(
  eventTitle: string,
  expiryDate: string | null | undefined,
  cached: { kalshiCount?: number; pmCount?: number; matchedCount?: number; scannedAt?: string; allArbs?: any[] },
): ScanResult {
  return {
    eventTitle,
    kalshiCount: cached.kalshiCount ?? 0,
    pmCount: cached.pmCount ?? 0,
    matchedCount: cached.matchedCount ?? 0,
    expiryDate: expiryDate ?? undefined,
    outcomes: (cached.allArbs ?? []).map((a: any): UnifiedOutcome => ({
      artist: a.artist,
      kalshi: (a.kalshiYesAsk != null || a.kalshiNoAsk != null || a.kalshiYesBid != null) ? {
        ticker: a.kalshiTicker ?? "",
        yesBid: a.kalshiYesBid ?? 0,
        yesAsk: a.kalshiYesAsk ?? 0,
        noBid: a.kalshiNoBid ?? 0,
        noAsk: a.kalshiNoAsk ?? 0,
        lastPrice: 0,
      } : null,
      polymarket: (a.pmYesPrice != null || a.pmNoPrice != null || a.pmBestAsk != null) ? {
        marketId: "",
        conditionId: a.pmConditionId ?? "",
        yesPrice: a.pmYesPrice ?? 0,
        noPrice: a.pmNoPrice ?? 0,
        bestBid: a.pmBestBid ?? 0,
        bestAsk: a.pmBestAsk ?? 0,
        lastTradePrice: 0,
      } : null,
      arbitrage: {
        strategy: a.strategy ?? "",
        kalshiStake: a.kalshiStake ?? 0,
        pmStake: a.pmStake ?? 0,
        expectedProfit: a.expectedProfit ?? 0,
        roiPct: a.roiPct ?? 0,
        apyPct: a.apyPct ?? a.roiPct ?? 0,
        buyPlatform: a.buyPlatform ?? null,
        buyPrice: a.buyPrice ?? 0,
        sellPlatform: a.sellPlatform ?? null,
        sellPrice: a.sellPrice ?? 0,
      },
    })),
    unmatchedKalshi: [],
    unmatchedPolymarket: [],
  };
}

export default function Home() {
  const [kalshiUrl, setKalshiUrl] = useState("");
  const [pmUrl, setPmUrl] = useState("");
  const [platformLinks, setPlatformLinks] = useState<PlatformLinkInput[]>([
    { id: "kalshi", platform: "kalshi", url: "" },
    { id: "polymarket", platform: "polymarket", url: "" },
  ]);
  const [capital, setCapital] = useState(100);
  // PERF-P2: ref mirror so the 60s auto-refresh interval doesn't tear down
  // and restart on every capital keystroke (capital was in its deps).
  const capitalRef = useRef(capital);
  useEffect(() => { capitalRef.current = capital; }, [capital]);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [bgRefreshing, setBgRefreshing] = useState(false); // BUG-032
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [lastScanTimestamp, setLastScanTimestamp] = useState<string | null>(null);
  const [expandedArtist, setExpandedArtist] = useState<string | null>(null);
  const [manualMatches, setManualMatches] = useState<ManualMatch[]>([]);
  const [couplingPanelOpen, setCouplingPanelOpen] = useState(false);
  const [decoupledPairs, setDecoupledPairs] = useState<any[]>([]);
  const previousPricesRef = useRef<Map<string, { kYes: number; pYes: number }>>(new Map());
  const [priceChanges, setPriceChanges] = useState<Map<string, "up" | "down" | null>>(new Map());
  const [savedMarkets, setSavedMarkets] = useState<SavedMarket[]>([]);
    const [sidebarOpen, setSidebarOpen] = useState(() => getStoredSidebarOpen());
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useSwipeGesture(
    () => { setMobileMenuOpen(false); },
    () => { setMobileMenuOpen(true); },
  );
  const [saving, setSaving] = useState(false);

  // Persist sidebar toggle
  useEffect(() => { persistSidebarOpen(sidebarOpen); }, [sidebarOpen]);
  const [activeMarketId, setActiveMarketId] = useState<string | null>(null);
  const [editingMarketId, setEditingMarketId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"scan" | "overview" | "marketfinder" | "live" | "dashboard" | "timing" | "logs" | "settings" | "trades" | "phantoms" | "couple-management">("overview");

  // Outcome table filter; entering a saved market resets this to matched.
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "matched" | "arb">("all");

  // Match mode: auto (default) or manual
  const [matchMode, setMatchMode] = useState<"auto" | "manual">("auto");

  // Refs for values used inside useCallback
  const savedMarketsRef = useRef<SavedMarket[]>(savedMarkets);
  const kalshiUrlRef = useRef(kalshiUrl);
  const pmUrlRef = useRef(pmUrl);
  const activeMarketIdRef = useRef(activeMarketId);
  // BUG-036: serialize MarketFinder individual saves to avoid concurrent read-modify-write races
  const mfSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => { savedMarketsRef.current = savedMarkets; }, [savedMarkets]);
  useEffect(() => { kalshiUrlRef.current = kalshiUrl; }, [kalshiUrl]);
  useEffect(() => { pmUrlRef.current = pmUrl; }, [pmUrl]);
  useEffect(() => { activeMarketIdRef.current = activeMarketId; }, [activeMarketId]);

  // Handle browser back/forward via popstate
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const state = e.state;
      if (state?.view === "overview") {
        setViewMode("overview");
        setActiveMarketId(null);
      } else if (state?.view === "marketfinder") {
        setViewMode("marketfinder");
        setActiveMarketId(null);
      } else if (state?.view === "scan") {
        if (state?.marketId) {
          const m = savedMarketsRef.current.find((m) => m.id === state.marketId);
          if (m) {
            setKalshiUrl(m.kalshiUrl);
            setPmUrl(m.polymarketUrl);
            setActiveMarketId(m.id);
            setOutcomeFilter("matched");
            kalshiUrlRef.current = m.kalshiUrl;
            pmUrlRef.current = m.polymarketUrl;
            activeMarketIdRef.current = m.id;
            setResult(null);
            previousPricesRef.current = new Map();
            setPriceChanges(new Map());
            const popExpiry = m.expiryDate ? new Date(m.expiryDate).getTime() : 0;
            if (!(popExpiry > 0 && popExpiry <= Date.now())) {
              handleScanWithUrls(m.kalshiUrl, m.polymarketUrl);
            }
          } else {
            // Market not in saved_markets — fall back to scan_results for URLs
            setViewMode("scan");
            fetch(`/api/saved-markets?id=${encodeURIComponent(state.marketId)}`)
              .then(r => r.ok ? r.json() : null)
              .then(d => {
                const fm = d?.market;
                if (fm?.kalshiUrl && fm?.polymarketUrl) {
                  setKalshiUrl(fm.kalshiUrl);
                  setPmUrl(fm.polymarketUrl);
                  kalshiUrlRef.current = fm.kalshiUrl;
                  pmUrlRef.current = fm.polymarketUrl;
                  setResult(null);
                  previousPricesRef.current = new Map();
                  setPriceChanges(new Map());
                  handleScanWithUrls(fm.kalshiUrl, fm.polymarketUrl);
                }
              })
              .catch(() => {});
          }
        } else {
          setViewMode("scan");
        }
      } else if (state?.view === "couple-management") {
        setViewMode("couple-management");
        setActiveMarketId(null);
      } else if (state?.view === "timing") {
        setViewMode("timing");
        setActiveMarketId(null);
      } else {
        setViewMode("overview");
        setActiveMarketId(null);
        window.history.replaceState({ view: "markets" }, "", "/?view=markets");
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

      if (view === "scan" && !marketId) {
        // A direct /?view=scan link is the empty manual-link form, not the dashboard.
        setViewMode("scan");
      } else if (view === "scan" && marketId) {
        const m = (initialMarkets as SavedMarket[]).find((m) => m.id === marketId);
        if (m) {
          setKalshiUrl(m.kalshiUrl);
          setPmUrl(m.polymarketUrl);
          setActiveMarketId(m.id);
          setOutcomeFilter("matched");
          kalshiUrlRef.current = m.kalshiUrl;
          pmUrlRef.current = m.polymarketUrl;
          activeMarketIdRef.current = m.id;
          setViewMode("scan");

          // UI-087/UI-084: show cached data instantly, then silent background refresh
          const isExpired = isMarketExpired(m);
          let cached = m.liveResult ?? m.lastScanResult;
          // Check if allArbs entries have price fields (not just artist/roi).
          // liveResult.allArbs from the watcher only stores { artist, roiPct,
          // expectedProfit, strategy } — no prices. lastScanResult.allArbs from
          // refresh-single.ts has full price fields. If the cached blob is sparse,
          // fetch the full market by id to get prices.
          const hasPrices = Array.isArray(cached?.allArbs) && (cached!.allArbs!.length === 0 || (cached!.allArbs![0] as any)?.kalshiYesAsk !== undefined || (cached!.allArbs![0] as any)?.pmYesPrice !== undefined);
          if (cached && !hasPrices && !isExpired) {
            try {
              const r = await fetch(`/api/saved-markets?id=${encodeURIComponent(m.id)}`);
              if (r.ok) {
                const d = await r.json();
                const full = d.market?.liveResult ?? d.market?.lastScanResult;
                if (full) cached = full;
              }
            } catch { /* fall back to blob-less cached */ }
          }
          if (cached && !isExpired) {
            const cachedResult: ScanResult = {
              eventTitle: m.eventTitle,
              category: m.category,
              kalshiCount: cached.kalshiCount ?? 0,
              pmCount: cached.pmCount ?? 0,
              matchedCount: cached.matchedCount ?? 0,
              expiryDate: m.expiryDate ?? undefined,
              outcomes: (cached.allArbs ?? []).map((a: any) => ({
                artist: a.artist,
                kalshi: a.kalshiTicker ? {
                  ticker: a.kalshiTicker,
                  yesBid: a.kalshiYesBid ?? 0,
                  yesAsk: a.kalshiYesAsk ?? 0,
                  noBid: a.kalshiNoBid ?? 0,
                  noAsk: a.kalshiNoAsk ?? 0,
                  lastPrice: 0,
                } : null,
                polymarket: a.pmConditionId ? {
                  marketId: '',
                  conditionId: a.pmConditionId,
                  yesPrice: a.pmYesPrice ?? 0,
                  noPrice: a.pmNoPrice ?? 0,
                  bestBid: a.pmBestBid ?? 0,
                  bestAsk: a.pmBestAsk ?? 0,
                  lastTradePrice: 0,
                } : null,
                arbitrage: {
                  strategy: a.strategy,
                  kalshiStake: a.kalshiStake ?? 0,
                  pmStake: a.pmStake ?? 0,
                  expectedProfit: a.expectedProfit ?? 0,
                  roiPct: a.roiPct ?? 0,
                  apyPct: a.apyPct ?? a.roiPct ?? 0,
                  buyPlatform: a.buyPlatform ?? null,
                  buyPrice: a.buyPrice ?? 0,
                  sellPlatform: a.sellPlatform ?? null,
                  sellPrice: a.sellPrice ?? 0,
                },
              })),
              unmatchedKalshi: [],
              unmatchedPolymarket: [],
            };
            setResult(cachedResult);
            setLastUpdated(new Date(cached.scannedAt));
            setLastScanTimestamp(cached.scannedAt ?? null);
          }
          // Background refresh (silent) — skip for expired markets
          if (!isExpired) {
            handleQuickPricesRefresh(marketId, true);
          }
        } else {
          // Market not in saved_markets (archived/never saved).
          // Fall back to scan_results to find URLs and auto-rescan.
          setViewMode("scan");
          try {
            const r = await fetch(`/api/saved-markets?id=${encodeURIComponent(marketId)}`);
            if (r.ok) {
              const d = await r.json();
              const fm = d?.market;
              if (fm?.kalshiUrl && fm?.polymarketUrl) {
                setKalshiUrl(fm.kalshiUrl);
                setPmUrl(fm.polymarketUrl);
                kalshiUrlRef.current = fm.kalshiUrl;
                pmUrlRef.current = fm.polymarketUrl;
                handleScanWithUrls(fm.kalshiUrl, fm.polymarketUrl);
              }
            }
          } catch { /* market not found anywhere — show empty form */ }
        }
      } else if (view === "overview") {
        // Backwards compat: old ?view=overview URLs redirect to Markets (now "overview" viewMode)
        setViewMode("overview");
      } else if (view === "markets") {
        setViewMode("overview");
      } else if (view === "marketfinder") {
        setViewMode("marketfinder");
        window.history.replaceState({ view: "marketfinder" }, "", "/?view=marketfinder");
        // Read multi-select categories from URL (?cats=a,b,c), fallback to legacy ?category=X
        const catsParam = params.get("cats");
        const legacyCat = params.get("category");
        if (catsParam) {
          const cats = catsParam.split(",");
          if (cats.every(c => (CATEGORIES as readonly string[]).includes(c))) {
            setMfCategories(cats);
          }
        } else if (legacyCat && (CATEGORIES as readonly string[]).includes(legacyCat)) {
          setMfCategories([legacyCat]);
        }
        const maxDays = params.get("maxDays");
        if (maxDays) {
          const n = parseInt(maxDays, 10);
          if (Number.isFinite(n) && n >= 1 && n <= 365) {
            setMfExpiryDays(n);
          }
        }
      } else if (view === "live") {
        setViewMode("live");
      } else if (view === "dashboard") {
        setViewMode("dashboard");
      } else if (view === "timing") {
        setViewMode("timing");
      } else if (view === "logs") {
        setViewMode("logs");
      } else if (view === "settings") {
        setViewMode("settings");
      } else if (view === "trades") {
        setViewMode("trades");
      } else if (view === "phantoms") {
        setViewMode("phantoms");
      } else if (view === "couple-management") {
        setViewMode("couple-management");
        window.history.replaceState({ view: "couple-management" }, "", "/?view=couple-management");
      } else {
        setViewMode("dashboard");
      }
    };
    syncFromUrl();
  }, []);

  const handleQuickPricesRefresh = async (marketId: string, silent = false) => {
    if (!silent) {
      setLoading(true);
    } else {
      setBgRefreshing(true);
    }
    setError("");

    try {
      const res = await fetch("/api/quick-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId,
          capital: capitalRef.current,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult((prev) => {
          if (!prev) return data as ScanResult;
          // Merge quick-prices outcome updates into the existing result so
          // UI state (expanded rows, sorting) is not lost.
          const next = { ...data } as ScanResult;
          if (prev.outcomes && data.outcomes) {
            const prevByArtist = new Map(prev.outcomes.map((o: UnifiedOutcome) => [o.artist, o]));
            next.outcomes = (data.outcomes as UnifiedOutcome[]).map((o: UnifiedOutcome) => {
              const old = prevByArtist.get(o.artist);
              if (!old) return o;
              return {
                ...old,
                kalshi: o.kalshi,
                polymarket: o.polymarket,
                arbitrage: o.arbitrage,
              };
            });
          }
          return next;
        });
        const scannedAt = new Date().toISOString();
        setLastUpdated(new Date(scannedAt));
        setLastScanTimestamp(scannedAt);
        if (Array.isArray(data.outcomes)) {
          const prices = new Map<string, { kYes: number; pYes: number }>();
          (data.outcomes as UnifiedOutcome[]).forEach((o: UnifiedOutcome) => {
            if (o.kalshi && o.polymarket) {
              prices.set(o.artist, { kYes: o.kalshi.yesAsk, pYes: o.polymarket.yesPrice });
            }
          });
          previousPricesRef.current = prices;
        }
      } else {
        setError(data.error || "Quick refresh failed");
      }
    } catch (err: any) {
      setError(err.message || "Network error");
    } finally {
      if (!silent) setLoading(false);
      else setBgRefreshing(false);
    }
  };

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

  const handleScanWithUrls = async (kUrl: string, pUrl: string, silent = false, forceFull = false) => {
    if (!silent) {
      setLoading(true);
      setResult(null);
    } else {
      setBgRefreshing(true); // BUG-032: show subtle refresh indicator for silent background scans
    }
    setError("");
    previousPricesRef.current = new Map();
    setPriceChanges(new Map());

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Manual input uses canonical, per-link platform metadata. Legacy
          // fields are only for programmatic scans of existing saved markets.
          ...(platformLinks.some((link) => link.url)
            ? { platformLinks: platformLinks.filter((link) => link.url).map(({ platform, url }) => ({ platform: platform ?? "", url })) }
            : { kalshiUrl: kUrl, polymarketUrl: pUrl }),
          capital: capital,
          skipAutoMatch: matchMode === "manual",
          force: forceFull,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult(data);
        const scannedAt = new Date().toISOString();
        setLastUpdated(new Date(scannedAt));
        setLastScanTimestamp(scannedAt);
        const scannedMarketId = activeMarketIdRef.current;
        if (scannedMarketId && Array.isArray(data.outcomes)) {
          const summary = summarizeScanForSidebar(data.outcomes);
          setSavedMarkets((previous) => previous.map((market) => market.id === scannedMarketId
            ? {
                ...market,
                liveResult: {
                  ...summary,
                  scannedAt,
                  kalshiCount: data.kalshiCount ?? 0,
                  pmCount: data.pmCount ?? 0,
                  matchedCount: data.matchedCount ?? 0,
                },
              }
            : market));
        }
        // Record initial prices for change detection
        const prices = new Map<string, { kYes: number; pYes: number }>();
        data.outcomes.forEach((o: UnifiedOutcome) => {
          if (o.kalshi && o.polymarket) {
            prices.set(o.artist, { kYes: o.kalshi.yesAsk, pYes: o.polymarket.yesPrice });
          }
        });
        previousPricesRef.current = prices;
        // HOOKUP-07: record spread point for historical chart (IndexedDB, client-side)
        // Save per-outcome so each row's sparkline shows its own ROI history.
        try {
          const mid = activeMarketIdRef.current;
          if (mid && Array.isArray(data.outcomes)) {
            const now = Date.now();
            for (const o of data.outcomes) {
              if (!o.kalshi || !o.polymarket || !o.arbitrage) continue;
              void saveSpread({
                ts: now,
                marketId: mid,
                outcomeArtist: o.artist,
                kalshiYesBid: o.kalshi.yesBid,
                kalshiYesAsk: o.kalshi.yesAsk,
                pmYesBid: o.polymarket.bestBid,
                pmYesAsk: o.polymarket.bestAsk,
                spread: Math.abs(o.kalshi.yesAsk - o.polymarket.yesPrice) * 100,
                strategy: o.arbitrage.strategy ?? "",
                roiPct: o.arbitrage.roiPct ?? 0,
              }).catch(() => {});
            }
          }
        } catch { /* chart persistence is best-effort */ }
      } else {
        setError(data.error || "Scan failed");
      }
    } catch (err: any) {
      setError(err.message || "Network error");
    } finally {
      if (!silent) setLoading(false);
      else setBgRefreshing(false);
    }
  };

  // Saved markets
  const loadSavedMarkets = async (): Promise<SavedMarket[]> => {
    try {
      const res = await fetch("/api/saved-markets?fields=basic");
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

  const loadDecoupledPairs = async () => {
    try {
      const res = await fetch("/api/decoupled-pairs");
      if (res.ok) {
        const data = await res.json();
        setDecoupledPairs(data.pairs || []);
      }
    } catch { /* ignore */ }
  };

  const handleDecouple = async (kalshiTicker: string, pmConditionId: string, kalshiTitle: string, pmTitle: string) => {
    try {
      await fetch("/api/decoupled-pairs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kalshiTicker, pmConditionId, kalshiTitle, pmTitle }),
      });
      await loadDecoupledPairs();
    } catch { /* ignore */ }
  };

  const handleRecouple = async (decoupledPairId: string) => {
    try {
      await fetch(`/api/decoupled-pairs?id=${decoupledPairId}`, { method: "DELETE" });
      await loadDecoupledPairs();
    } catch { /* ignore */ }
  };

  // Scan ALL saved markets with LIVE prices — async background refresh with progress polling
  const scanAllMarkets = async (marketsToScan?: SavedMarket[]) => {
    if (scanningAll) return;
    setScanningAll(true);
    setScanAllError("");

    try {
      const ids = marketsToScan && marketsToScan.length > 0
        ? marketsToScan.map((m) => m.id).join(',')
        : undefined;
      const startRes = await fetch('/api/saved-markets/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ ids: ids ? ids.split(',') : undefined }),
      });
      if (!startRes.ok) {
        const err = await startRes.text();
        throw new Error(err || 'Failed to start refresh job');
      }

      let status: any = {};
      let attempts = 0;
      const maxAttempts = 360; // ~6 min at 1s polling (backend has 5 min timeout)

      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000));
        const statusRes = await fetch(`/api/saved-markets/refresh?_=${Date.now()}`, {
          headers: { 'Cache-Control': 'no-store' },
        });
        if (statusRes.ok) {
          const data = await statusRes.json();
          status = data.status || {};
          setScanProgress({ current: status.processed ?? 0, total: status.total ?? 0 });
          if (!status.running) break;
        } else {
          // If status endpoint fails, keep scanning locally; break after 30s to avoid spinning
          if (attempts > 30) break;
        }
        attempts++;
      }

      await loadSavedMarkets();

      // Check for timeout error from backend
      if (status.errors?.some((e: any) => e.id === '__timeout__')) {
        const timeoutErr = status.errors.find((e: any) => e.id === '__timeout__');
        setScanAllError(timeoutErr.error);
      } else if (status.failed > 0) {
        setScanAllError(`${status.failed} market${status.failed > 1 ? 's' : ''} failed to refresh`);
      }
    } catch (e: any) {
      console.error('[scanAllMarkets]', e);
      setScanAllError(e.message || 'Refresh failed');
    } finally {
      setScanningAll(false);
      setScanProgress({ current: 0, total: 0 });
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
          window.history.replaceState({ view: "markets" }, "", "/?view=markets");
        }
      }
    } catch { /* ignore */ }
  };

  // Update a saved market in local state after PATCH returns the updated market
  const updateMarketInState = (updated: SavedMarket) => {
    setSavedMarkets(prev => prev.map(m => m.id === updated.id ? updated : m));
    // If currently viewing this market, also update the displayed result title/category/expiry
    if (activeMarketId === updated.id && result) {
      setResult(prev => prev ? { ...prev, eventTitle: updated.eventTitle, category: updated.category, expiryDate: updated.expiryDate ?? prev.expiryDate } : prev);
    }
  };

  // Save market from scan result
  const saveMarket = async () => {
    if (!result) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/saved-markets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kalshiUrl: kalshiUrlRef.current,
          polymarketUrl: pmUrlRef.current,
          eventTitle: result.eventTitle,
          category: result.category,
        }),
      });
      if (res.status === 409 || res.status === 400 || !res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error?.includes("already exists") || res.status === 409) {
          setError(`⚠️ "${result.eventTitle}" is already saved.`);
          setTimeout(() => setError(""), 4000);
          return;
        }
        setError(data.error || "Failed to save market");
        return;
      }
      await loadSavedMarkets();
    } catch (err: any) {
      setError(err.message || "Network error");
    } finally {
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
        // Auto re-scan the current market so the new pairing shows up immediately
        if (kalshiUrlRef.current && pmUrlRef.current) {
          handleScanWithUrls(kalshiUrlRef.current, pmUrlRef.current, true);
        }
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
  const loadMarket = async (m: SavedMarket, options?: { forceFull?: boolean }) => {
    const forceFull = options?.forceFull ?? false;
    setKalshiUrl(m.kalshiUrl);
    setPmUrl(m.polymarketUrl);
    setActiveMarketId(m.id);
    // UI-10: every newly opened saved market starts in the matched-only view.
    setOutcomeFilter("matched");
    kalshiUrlRef.current = m.kalshiUrl;
    pmUrlRef.current = m.polymarketUrl;
    activeMarketIdRef.current = m.id;
    setViewMode("scan");
    window.history.pushState({ view: "scan", marketId: m.id }, "", `/?view=scan&id=${m.id}`);

    const isExpired = isMarketExpired(m);

    // Build cached result from lastScanResult/liveResult to show instantly.
    // Sidebar payload (fields=basic) strips allArbs — fetch the single full
    // market by id (tiny, local) when the blob is missing.
    let cached = m.liveResult ?? m.lastScanResult;
    const hasFullArbs = Array.isArray(cached?.allArbs) && (cached!.allArbs!.length === 0 || (cached!.allArbs![0] as any)?.artist !== undefined);
    if (cached && !hasFullArbs && !isExpired) {
      try {
        const r = await fetch(`/api/saved-markets?id=${encodeURIComponent(m.id)}`);
        if (r.ok) {
          const d = await r.json();
          const full = d.market?.liveResult ?? d.market?.lastScanResult;
          if (full) cached = full;
        }
      } catch { /* fall back to blob-less cached */ }
    }
    if (cached && !isExpired) {
      const cachedResult: ScanResult = {
        eventTitle: m.eventTitle,
        category: m.category,
        kalshiCount: cached.kalshiCount ?? 0,
        pmCount: cached.pmCount ?? 0,
        matchedCount: cached.matchedCount ?? 0,
        expiryDate: m.expiryDate ?? undefined,
        outcomes: (cached.allArbs ?? []).map((a: any) => ({
          artist: a.artist,
          kalshi: a.kalshiTicker ? {
            ticker: a.kalshiTicker,
            yesBid: a.kalshiYesBid ?? 0,
            yesAsk: a.kalshiYesAsk ?? 0,
            noBid: a.kalshiNoBid ?? 0,
            noAsk: a.kalshiNoAsk ?? 0,
            lastPrice: 0,
          } : null,
          polymarket: a.pmConditionId ? {
            marketId: '',
            conditionId: a.pmConditionId,
            yesPrice: a.pmYesPrice ?? 0,
            noPrice: a.pmNoPrice ?? 0,
            bestBid: a.pmBestBid ?? 0,
            bestAsk: a.pmBestAsk ?? 0,
            lastTradePrice: 0,
          } : null,
          arbitrage: {
            strategy: a.strategy,
            kalshiStake: a.kalshiStake ?? 0,
            pmStake: a.pmStake ?? 0,
            expectedProfit: a.expectedProfit ?? 0,
            roiPct: a.roiPct ?? 0,
            apyPct: a.apyPct ?? a.roiPct ?? 0,
            buyPlatform: a.buyPlatform ?? null,
            buyPrice: a.buyPrice ?? 0,
            sellPlatform: a.sellPlatform ?? null,
            sellPrice: a.sellPrice ?? 0,
          },
        })),
        unmatchedKalshi: [],
        unmatchedPolymarket: [],
      };
      setResult(cachedResult);
      setLastUpdated(new Date(cached.scannedAt));
      setLastScanTimestamp(cached.scannedAt ?? null);
    } else {
      // Expired market: show empty result with clear state
      setResult({
        eventTitle: m.eventTitle,
        category: m.category,
        kalshiCount: cached?.kalshiCount ?? 0,
        pmCount: cached?.pmCount ?? 0,
        matchedCount: 0,
        expiryDate: m.expiryDate ?? undefined,
        outcomes: [],
        unmatchedKalshi: [],
        unmatchedPolymarket: [],
        expired: true,
      } as ScanResult);
      setLastUpdated(null);
      setLastScanTimestamp(null);
    }

    // Background refresh (silent) — skip for expired markets (BUG-033)
    if (!isExpired) {
      if (forceFull) {
        handleScanWithUrls(m.kalshiUrl, m.polymarketUrl, true, true);
      } else {
        handleQuickPricesRefresh(m.id, true);
      }
    }
  };

  // View mode switcher
  const goToMarketFinder = () => {
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

  // MF expiry days slider — updates state + URL
  const setMfExpiryDaysUrl = useCallback((days: number) => {
    const clamped = Math.min(365, Math.max(1, days));
    setMfExpiryDays(clamped);
    persistMfExpiryDays(clamped);
    const params = new URLSearchParams(window.location.search);
    params.set("view", "marketfinder");
    params.set("maxDays", String(clamped));
    window.history.replaceState({ view: "marketfinder" }, "", `/?${params.toString()}`);
  }, []);

  const goToOverview = () => {
    setCouplingPanelOpen(false);
    setViewMode("overview");
    window.history.replaceState({ view: "markets" }, "", "/?view=markets");
  };

  const goToLogs = () => {
    setCouplingPanelOpen(false);
    setViewMode("logs");
    window.history.replaceState({ view: "logs" }, "", "/?view=logs");
  };

  const goToDashboard = () => {
    setCouplingPanelOpen(false);
    setViewMode("dashboard");
    window.history.replaceState({ view: "dashboard" }, "", "/?view=dashboard");
  };

  const goToTiming = () => {
    setCouplingPanelOpen(false);
    setViewMode("timing");
    window.history.replaceState({ view: "timing" }, "", "/?view=timing");
  };

  const goToSettings = () => {
    setCouplingPanelOpen(false);
    setViewMode("settings");
    window.history.replaceState({ view: "settings" }, "", "/?view=settings");
  };

  // TRADES-001
  const goToTrades = () => {
    setCouplingPanelOpen(false);
    setViewMode("trades");
    window.history.replaceState({ view: "trades" }, "", "/?view=trades");
  };

  const goToCoupleManagement = () => {
    setCouplingPanelOpen(false);
    setViewMode("couple-management");
    window.history.replaceState({ view: "couple-management" }, "", "/?view=couple-management");
  };

  const goToScan = () => {
    setActiveMarketId(null);
    activeMarketIdRef.current = null;
    setResult(null);
    setKalshiUrl("");
    setPmUrl("");
    kalshiUrlRef.current = "";
    pmUrlRef.current = "";
    previousPricesRef.current = new Map();
    setPriceChanges(new Map());
    setViewMode("scan");
    window.history.replaceState({ view: "scan" }, "", "/?view=scan");
  };

  // Sort helpers
  const [overviewSort, setOverviewSort] = useState<OverviewSort>("apy");
  const [overviewSortDir, setOverviewSortDir] = useState<"asc" | "desc">("desc");
  const [overviewLayout, setOverviewLayout] = useState<"grid" | "table">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("overviewLayout");
      if (saved === "grid" || saved === "table") return saved;
    }
    return "table"; // default to table view (UI-012)
  });
  // Persist layout preference (UI-012)
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("overviewLayout", overviewLayout);
    }
  }, [overviewLayout]);
  const [overviewExpiryFilter, setOverviewExpiryFilter] = useState<"all" | "lte7" | "lte14" | "lte30">(DEFAULT_MARKET_EXPIRY_FILTER);
  const [showExpired, setShowExpired] = useState(false);
  const [showArbOnly, setShowArbOnly] = useState(DEFAULT_SHOW_ARB_ONLY);
  const [scanningAll, setScanningAll] = useState(false);
  const [copiedLinks, setCopiedLinks] = useState(false); // UI-013
  const [scanAllError, setScanAllError] = useState("");
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [bookmakerView, setBookmakerView] = useState(false);

  // Favorites state (persisted to localStorage)
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(getStoredFavoriteIds);
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

  // Persist favorites to localStorage whenever they change
  useEffect(() => {
    persistFavoriteIds(favoriteIds);
  }, [favoriteIds]);

  // Auto-fetch state
  const [overviewLoading, setOverviewLoading] = useState(false);

  // MarketFinder state
  const [mfMarkets, setMfMarkets] = useState<any[]>([]);
  const [mfAllMarkets, setMfAllMarkets] = useState<any[]>([]);
  const [mfLoading, setMfLoading] = useState(false);
  const [mfSyncing, setMfSyncing] = useState(false);
  const [mfError, setMfError] = useState("");
  const [mfLastSync, setMfLastSync] = useState<any>(null);
  const [mfSavingIds, setMfSavingIds] = useState<Set<string>>(new Set());
  // MF category filter — multi-select (empty = all categories)
  const [mfCategories, setMfCategories] = useState<string[]>(getStoredMfCategories);
  const mfAutoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // MF cache with TTL
  const mfCacheRef = useRef<{ data: any[]; fetchedAt: number }>({ data: [], fetchedAt: 0 });
  const MF_CACHE_TTL_MS = 30000;

  // MF spread threshold (configurable, default 14%)
  const [mfSpreadThreshold, setMfSpreadThreshold] = useState(14);
  const [mfExpiryDays, setMfExpiryDays] = useState(getStoredMfExpiryDays);

  // MF fetch count — caps PredictionHunt API usage (default 3)
  const [mfFetchCount, setMfFetchCount] = useState(20);

  // ── MF matched/unmatched filter (all | matched | unmatched) ──
  const [mfMatchFilter, setMfMatchFilter] = useState<"all" | "matched" | "unmatched">("all");

  // ── MF show-all toggle (fetched from both platforms) ──
  const [mfShowAllPlatforms, setMfShowAllPlatforms] = useState(false);

  // ── MF auto-refresh toggle (persisted, default: enabled) ──
  const [mfAutoRefreshEnabled, setMfAutoRefreshEnabled] = useState(getStoredMfAutoRefresh);

  // ── MF bulk selection state (persisted to localStorage) ──
  const [mfSelectedIds, setMfSelectedIds] = useState<Set<string>>(getStoredMfSelectedIds);
  const [mfBulkSaving, setMfBulkSaving] = useState(false);
  const [mfBulkMsg, setMfBulkMsg] = useState("");

  // Alert system

  const [alertSettingsOpen, setAlertSettingsOpen] = useState(false);

  // Sidebar sort — default APY desc (highest first)
  const [sidebarSort, setSidebarSort] = useState<"name" | "roi" | "expiry" | "apy" | "scanned">("apy");
  const [sidebarSortDir, setSidebarSortDir] = useState<"asc" | "desc">("desc");

  // Outcome table sort — default largest quoted cross-platform spread first
  const [outcomeSort, setOutcomeSort] = useState<"roi" | "apy" | "profit" | "spread">("spread");
  const [outcomeSortDir, setOutcomeSortDir] = useState<"asc" | "desc">("desc");

  // Load saved markets on mount
  useEffect(() => { loadSavedMarkets(); }, []);
  useEffect(() => { loadManualMatches(); loadDecoupledPairs(); }, []);

  // Auto-refresh saved markets every 60s (gentle — poller handles scanning)
  useEffect(() => {
    const iv = setInterval(() => loadSavedMarkets(), 60000);
    return () => clearInterval(iv);
  }, []);

  // Auto-refresh ACTIVE market prices every 60s when viewing a market
  useEffect(() => {
    if (!activeMarketId || viewMode !== "scan") return;

    const iv = setInterval(() => {
      handleQuickPricesRefresh(activeMarketId, true);
    }, 60000);

    return () => clearInterval(iv);
  }, [activeMarketId, viewMode]);

  // Auto-fetch MarketFinder data when entering marketfinder view
  useEffect(() => {
    if (viewMode !== "marketfinder") return;

    const isCacheValid = mfCacheRef.current.fetchedAt > 0 && 
      (Date.now() - mfCacheRef.current.fetchedAt) < MF_CACHE_TTL_MS &&
      !window.location.search.includes("fresh=true");

    if (isCacheValid && mfCacheRef.current.data.length > 0) {
      // Use cached data instantly
      setMfMarkets(mfCacheRef.current.data);
      // Still fetch fresh data in background
      fetchFreshMfMarkets(false);
    } else {
      fetchFreshMfMarkets(true);
    }
  }, [viewMode, mfCategories, mfExpiryDays, mfFetchCount]);

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
      setMfBulkMsg(`${saved} market${saved !== 1 ? "s" : ""} saved to EdgeFinder`);
    }
    setTimeout(() => setMfBulkMsg(""), 3000);
  }, [mfSelectedIds, mfBulkSaving, mfMarkets]);

  /** Fetch fresh MF markets from API with current category + expiry + fetchCount filters */
  const fetchFreshMfMarkets = useCallback((showLoading: boolean) => {
    if (showLoading) setMfLoading(true);
    setMfError("");
    const cats = mfCategories.join(",");
    const url = `/api/predictionhunt/markets?${cats ? `category=${encodeURIComponent(cats)}&` : ""}maxDays=${mfExpiryDays}&fetchCount=${mfFetchCount}`;
    fetch(url, { headers: { "Cache-Control": "no-store" } })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          const markets = d.markets || [];
          setMfMarkets(markets);
          if (d.lastSync) setMfLastSync(d.lastSync);
          // Update cache
          mfCacheRef.current = { data: markets, fetchedAt: Date.now() };
        }
        setMfError("");
      })
      .catch(() => setMfError("Failed to load MarketFinder data"))
      .finally(() => { if (showLoading) setMfLoading(false); });
  }, [mfCategories, mfExpiryDays, mfFetchCount]);

  /** Fetch ALL markets from both platforms (raw, unmatched) */
  const fetchAllMfMarkets = useCallback(() => {
    setMfLoading(true);
    setMfError("");
    fetch("/api/predictionhunt/markets?action=fetch-all", { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          // Combine PM + Kalshi markets into unified format
          const pm = (d.polymarket || []).map((m: any) => ({
            ...m,
            id: `pm-${m.id}`,
            platform: 'polymarket',
            title: m.title,
            eventType: m.category || 'unknown',
            eventDate: m.expiration_date,
            polymarketUrl: m.source_url,
            kalshiUrl: null,
            spreadPct: null,
            matched: false,
          }));
          const k = (d.kalshi || []).map((m: any) => ({
            ...m,
            id: `k-${m.id}`,
            platform: 'kalshi',
            title: m.title,
            eventType: m.category || 'unknown',
            eventDate: m.expiration_date,
            polymarketUrl: null,
            kalshiUrl: m.source_url,
            spreadPct: null,
            matched: false,
          }));
          // Merge and sort by title
          const all = [...pm, ...k].sort((a, b) => a.title.localeCompare(b.title));
          setMfAllMarkets(all);
          setMfShowAllPlatforms(true);
        }
      })
      .catch(() => setMfError("Failed to fetch all markets"))
      .finally(() => setMfLoading(false));
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
  const toggleSidebarSort = (field: "name" | "roi" | "expiry" | "apy" | "scanned") => {
    if (sidebarSort === field) {
      setSidebarSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSidebarSort(field);
      // Text columns default to asc (A→Z); numeric columns default to desc (high→low)
      const textFields: ("name" | "roi" | "expiry" | "apy" | "scanned")[] = ["name"];
      if (textFields.includes(field)) setSidebarSortDir("asc");
      else setSidebarSortDir("desc");
    }
  };

  // Toggle outcome table sort
  const toggleOutcomeSort = (field: "roi" | "apy" | "profit" | "spread") => {
    if (outcomeSort === field) {
      setOutcomeSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setOutcomeSort(field);
      // All outcome-table numeric columns default to desc (high→low)
      setOutcomeSortDir("desc");
    }
  };

  // Toggle overview sort
  const toggleOverviewSort = (field: OverviewSort) => {
    if (overviewSort === field) {
      setOverviewSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setOverviewSort(field);
      // Text columns default to asc (A→Z), numeric columns default to desc (high→low)
      const textFields: OverviewSort[] = ["name", "strategy"];
      const ascFields: OverviewSort[] = ["expiry"];
      if (textFields.includes(field)) setOverviewSortDir("asc");
      else if (ascFields.includes(field)) setOverviewSortDir("asc");
      else setOverviewSortDir("desc"); // "scanned" desc = most recent first (matches sidebar)
    }
  };

  // Theme
  const theme = useTheme();

  // ── Render ──
  return (
    <div className="h-screen bg-[var(--surface-workspace)] text-[var(--text-primary)] flex flex-col overflow-hidden">
      {alertSettingsOpen && <AlertSettingsPanel onClose={() => setAlertSettingsOpen(false)} />}

      {/* Top nav bar */}
      <header className="sticky top-0 z-50 border-b border-[var(--border-subtle)] bg-[var(--surface-workspace)]/90 backdrop-blur">
        <div className="flex items-center h-14 px-4 gap-3">
          <button onClick={() => setMobileMenuOpen(v => !v)} className="lg:hidden p-2 rounded-lg hover:bg-[var(--border-subtle)]">
            <Rows3 className="w-5 h-5" />
          </button>
          <button onClick={() => setSidebarOpen(v => !v)} className="hidden lg:flex p-2 rounded-lg hover:bg-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}>
            <PanelLeft className={`w-5 h-5 transition-transform ${!sidebarOpen ? "rotate-180" : ""}`} />
          </button>
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--status-positive)]/15 border border-[var(--status-positive)]/30">
              <Radar className="w-4 h-4 text-[var(--status-positive)]" />
            </div>
            <h1 className="text-base font-bold tracking-tight">EdgeFinder</h1>
          </div>
          <ExecutionModeBadge />

          <div className="ml-auto flex items-center gap-2">
            <button onClick={goToCoupleManagement} className={`p-2 rounded-lg hover:bg-[var(--border-subtle)] transition-colors ${viewMode === "couple-management" ? "text-[var(--status-positive)] bg-[var(--status-positive)]/10" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`} title="Couple Management">
              <GitMerge className="w-4 h-4" />
            </button>
            <button onClick={() => setViewMode("live")} className={`p-2 rounded-lg hover:bg-[var(--border-subtle)] transition-colors ${viewMode === "live" ? "text-[var(--status-positive)] bg-[var(--status-positive)]/10" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`} title="Live WebSocket scan">
              <Activity className="w-4 h-4" />
            </button>
            <button onClick={() => setAlertSettingsOpen(true)} className="p-2 rounded-lg hover:bg-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="Alert settings">
              <Bell className="w-4 h-4" />
            </button>
            <button onClick={goToSettings} className={`p-2 rounded-lg hover:bg-[var(--border-subtle)] transition-colors ${viewMode === "settings" ? "text-[var(--status-positive)] bg-[var(--status-positive)]/10" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`} title="App settings">
              <SettingsIconLucide className="w-4 h-4" />
            </button>
            <button onClick={() => theme.toggleTheme()} className="p-2 rounded-lg hover:bg-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="Toggle theme">
              {theme.theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden">
        <MarketSidebar
          markets={savedMarkets}
          activeId={activeMarketId}
          viewMode={viewMode}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(v => !v)}
          onSelectMarket={loadMarket}
          onDeleteMarket={(id) => { if (confirm("Delete market?")) deleteMarket(id); }}
          sort={sidebarSort}
          sortDir={sidebarSortDir}
          onToggleSort={toggleSidebarSort}
          timeUntilExpiry={timeUntilExpiry}
          expiryFilter={overviewExpiryFilter}
          onSetExpiryFilter={setOverviewExpiryFilter}
          showExpired={showExpired}
          onToggleShowExpired={() => setShowExpired(v => !v)}
          showArbOnly={showArbOnly}
          onToggleShowArbOnly={() => setShowArbOnly(v => !v)}
          onScanAll={scanAllMarkets}
          scanningAll={scanningAll}
          scanProgress={scanProgress}
          scanAllError={scanAllError}
          onGoOverview={goToOverview}
          onGoScan={goToScan}
          onGoMarketFinder={goToMarketFinder}
          onGoLogs={goToLogs}
          onGoDashboard={goToDashboard}
          onGoTiming={goToTiming}
          onGoTrades={goToTrades}
          onGoCoupleManagement={goToCoupleManagement}
          favoriteIds={favoriteIds}
          onToggleFavorite={toggleFavorite}
          sidebarFavoritesOnly={sidebarFavoritesOnly}
          onToggleSidebarFavorites={() => setSidebarFavoritesOnly(v => !v)}
          mobileMenuOpen={mobileMenuOpen}
          onCloseMobileMenu={() => setMobileMenuOpen(false)}
        />
        <div className="flex-1 overflow-y-auto">
          <div className="w-full p-2 sm:p-4 md:p-6 2xl:p-8">
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
                showArbOnly={showArbOnly}
                onToggleShowArbOnly={() => setShowArbOnly(v => !v)}
                showExpired={showExpired}
                onToggleShowExpired={() => setShowExpired(v => !v)}
                timeUntilExpiry={timeUntilExpiry}
                formatExpiry={formatExpiry}
                onSelectMarket={loadMarket}
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
                expiryDays={mfExpiryDays}
                fetchCount={mfFetchCount}
                categories={mfCategories}
                autoRefreshEnabled={mfAutoRefreshEnabled}
                onSetFetchCount={setMfFetchCount}
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
                        // After full sync, refresh with current filters
                        fetchFreshMfMarkets(false);
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
                  // BUG-036: chain saves on a queue so rapid clicks don't race the backend read-modify-write
                  mfSaveQueueRef.current = mfSaveQueueRef.current.then(() =>
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
                    })
                  );
                }}
                onToggleSelected={toggleMfSelected}
                onToggleSelectAll={toggleMfSelectAll}
                onBulkSave={mfBulkSave}
                onSetCategories={setMfCategoriesUrl}
                onSetExpiryDays={setMfExpiryDaysUrl}
                onToggleAutoRefresh={(enabled) => {
                  setMfAutoRefreshEnabled(enabled);
                  persistMfAutoRefresh(enabled);
                }}
                allMarkets={mfAllMarkets}
                showAllPlatforms={mfShowAllPlatforms}
                onFetchAll={fetchAllMfMarkets}
                onToggleShowAllPlatforms={() => setMfShowAllPlatforms(v => !v)}
                matchFilter={mfMatchFilter}
                onSetMatchFilter={setMfMatchFilter}
              />
            ) : viewMode === "live" ? (
              <LiveScanPanel capital={capital} savedMarkets={savedMarkets} />
            ) : viewMode === "dashboard" ? (
              <DashboardPanel />
            ) : viewMode === "timing" ? (
              <ArbTimingPanel />
            ) : viewMode === "logs" ? (
              <LogsPanel />
            ) : viewMode === "settings" ? (
              <SettingsPanel />
            ) : viewMode === "trades" ? (
              <TradesPanel />
            ) : viewMode === "phantoms" ? (
              <PhantomsPanel />
            ) : viewMode === "couple-management" ? (
              <CoupleManagementPanel />
            ) : (
              <>
                {/* Scan inputs */}
                {!activeMarketId && (
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3 sm:p-4 md:p-5 mb-4 sm:mb-6">
                  {/* FEAT-015: category picker — browse matched pairs instead of pasting URLs */}
                  <ScanCategoryPicker onPick={(k, pm) => {
                    setKalshiUrl(k); setPmUrl(pm);
                    setPlatformLinks([
                      { id: "kalshi", platform: "kalshi", url: k },
                      { id: "polymarket", platform: "polymarket", url: pm },
                    ]);
                  }} />
                  <PlatformLinkInputs
                    links={platformLinks}
                    onChange={(links) => {
                      setPlatformLinks(links);
                      const kalshi = links.find((link) => link.platform === "kalshi")?.url ?? "";
                      const polymarket = links.find((link) => link.platform === "polymarket")?.url ?? "";
                      setKalshiUrl(kalshi);
                      setPmUrl(polymarket);
                    }}
                  />

                  {/* Auto/Manual match toggle */}
                  <div className="flex flex-col items-stretch gap-2 mb-4 sm:flex-row sm:items-center">
                    <span className="text-xs text-[var(--text-secondary)]">Match Mode:</span>
                    <div className="flex rounded-lg bg-[var(--surface-workspace)] border border-[var(--border-subtle)] p-0.5">
                      <button
                        onClick={() => setMatchMode("auto")}
                        className={`min-h-11 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                          matchMode === "auto"
                            ? "bg-[var(--status-positive)] text-black"
                            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        Auto Match
                      </button>
                      <button
                        onClick={() => setMatchMode("manual")}
                        className={`min-h-11 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                          matchMode === "manual"
                            ? "bg-[var(--platform-polymarket)] text-white"
                            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        Manual Match
                      </button>
                    </div>
                    {matchMode === "manual" && (
                      <span className="text-[10px] text-[var(--platform-polymarket)]/70">Link markets manually after scan</span>
                    )}
                  </div>

                  <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:flex-wrap">
                    <button onClick={() => handleScan(false)} disabled={loading} className="flex min-h-11 items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--status-positive)] text-black font-semibold text-sm hover:brightness-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scan className="w-4 h-4" />}
                      {loading ? "Scanning..." : "Scan Markets"}
                    </button>

                    {result && (
                      <button onClick={saveMarket} disabled={saving} className="flex min-h-11 items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[var(--border-subtle)] border border-[var(--border-strong)] text-[var(--text-primary)] text-sm hover:bg-[var(--border-strong)] transition-all disabled:opacity-50">
                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        {saving ? "Saving..." : "Save Market"}
                      </button>
                    )}

                    <div className="flex min-h-11 items-center gap-2 sm:ml-auto">
                      <label className="text-xs text-[var(--text-secondary)]">Capital:</label>
                      <input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))} className="h-11 w-24 px-2 py-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--status-positive)]" />
                      <button
                        onClick={() => setCouplingPanelOpen(v => !v)}
                        className={`flex min-h-11 items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors ${
                          couplingPanelOpen
                            ? "border-[var(--status-positive)]/30 bg-[var(--status-positive)]/10 text-[var(--status-positive)]"
                            : "border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                        title="Toggle coupling panel"
                      >
                        <PanelRight className="w-3.5 h-3.5" />
                        <span className="text-[10px]">Couplings</span>
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div className="mt-3 flex items-center gap-2 text-sm text-[var(--status-negative)]">
                      <AlertCircle className="w-4 h-4" /> {error}
                    </div>
                  )}
                </div>
                )}

                {/* Loading state */}
                {loading && (
                  <div className="py-20 text-center text-sm text-[var(--text-secondary)]">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
                    Scanning markets...
                  </div>
                )}

                {/* Results */}
                {result && (
                  <div className="space-y-4">
                    {/* ── Market Header: Title OUTSIDE + Chips in separate box-containers ── */}
                    {activeMarketId && (
                      <>
                        {/* Title row */}
                        <div className="flex items-center gap-2 mb-3">
                          <h2 className="text-sm font-bold text-[var(--text-primary)] truncate">{result.eventTitle}</h2>
                          {savedMarkets.find(m => m.id === activeMarketId)?.category && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-[var(--border-subtle)] text-[var(--text-secondary)]">
                              {savedMarkets.find(m => m.id === activeMarketId)?.category}
                            </span>
                          )}
                        </div>

                        {/* Data chips — separate rounded box-containers */}
                        <div className="flex items-center gap-2 flex-wrap mb-4">
                          {/* Kalshi link chip */}
                          <a
                            href={savedMarkets.find(m => m.id === activeMarketId)?.kalshiUrl || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-[var(--border-subtle)] hover:border-[var(--status-positive)]/50 transition-colors"
                            title="Open Kalshi market"
                          >
                            <img src="/kalshi-icon.png" alt="Kalshi" className="w-4 h-4 rounded-sm" />
                            <span className="text-[10px] text-[var(--text-secondary)]">Kalshi</span>
                          </a>

                          {/* Polymarket link chip */}
                          <a
                            href={savedMarkets.find(m => m.id === activeMarketId)?.polymarketUrl || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-[var(--border-subtle)] hover:border-[var(--platform-polymarket)]/50 transition-colors"
                            title="Open Polymarket"
                          >
                            <img src="/polymarket-icon.png" alt="Polymarket" className="w-4 h-4 rounded-sm" />
                            <span className="text-[10px] text-[var(--text-secondary)]">Polymarket</span>
                          </a>

                          {/* UI-013: Links button — copy URLs to clipboard */}
                          <button
                            onClick={() => {
                              const market = savedMarkets.find(m => m.id === activeMarketId);
                              if (!market) return;
                              const text = `Kalshi: ${market.kalshiUrl}\nPolymarket: ${market.polymarketUrl}`;
                              navigator.clipboard.writeText(text).then(() => {
                                setCopiedLinks(true);
                                setTimeout(() => setCopiedLinks(false), 2000);
                              });
                            }}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-[var(--border-subtle)] transition-colors"
                            title="Copy Kalshi + Polymarket URLs"
                          >
                            {copiedLinks ? <Check className="w-3 h-3 text-[var(--status-positive)]" /> : <Link2 className="w-3 h-3 text-[var(--text-secondary)]" />}
                            <span className="text-[10px] text-[var(--text-secondary)]">{copiedLinks ? "Copied!" : "Copy URLs"}</span>
                          </button>

                          {/* Refresh chip */}
                          <button
                            onClick={() => {
                              const market = savedMarkets.find(m => m.id === activeMarketId);
                              if (market) handleQuickPricesRefresh(activeMarketId, false);
                            }}
                            disabled={loading}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-[var(--border-subtle)] transition-colors disabled:opacity-50"
                            title="Refresh prices"
                          >
                            {loading || bgRefreshing ? <Loader2 className="w-3 h-3 animate-spin text-[var(--status-positive)]" /> : <RefreshCw className="w-3 h-3 text-[var(--text-secondary)]" />}
                            <span className="text-[10px] text-[var(--text-primary)]">{bgRefreshing ? "Refreshing prices…" : lastUpdated ? Math.round((Date.now() - new Date(lastUpdated).getTime()) / 1000) + "s ago" : "—"}</span>
                          </button>

                          {/* Full Re-scan chip */}
                          <button
                            onClick={() => {
                              const market = savedMarkets.find(m => m.id === activeMarketId);
                              if (market) handleScanWithUrls(market.kalshiUrl, market.polymarketUrl, false, true);
                            }}
                            disabled={loading}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-[var(--border-subtle)] transition-colors disabled:opacity-50"
                            title="Full re-scan (discover sibling series + depth)"
                          >
                            {loading ? <Loader2 className="w-3 h-3 animate-spin text-[var(--status-positive)]" /> : <Scan className="w-3 h-3 text-[var(--text-secondary)]" />}
                            <span className="text-[10px] text-[var(--text-primary)]">Full Re-scan</span>
                          </button>

                          {/* Data chips (config-driven) */}
                          {([
                            { label: "Kalshi", icon: <img src="/kalshi-icon.png" alt="Kalshi" className="w-4 h-4 rounded-sm" />, value: String(result.kalshiCount), valueClass: "text-[var(--text-primary)]", dim: false },
                            { label: "Polymarket", icon: <img src="/polymarket-icon.png" alt="Polymarket" className="w-4 h-4 rounded-sm" />, value: String(result.pmCount), valueClass: "text-[var(--text-primary)]", dim: false },
                            { label: "Matched", icon: <div className="flex items-center justify-center w-4 h-4 rounded-sm bg-[var(--status-positive)]"><Check className="w-2.5 h-2.5 text-[var(--text-primary)]" /></div>, value: String(result.matchedCount), valueClass: "text-[var(--text-primary)]", dim: false },
                            { label: "Total Profit", icon: <TrendingUp className="w-3 h-3 text-[var(--status-positive)]" />, value: result.expired ? "—" : formatCurrency((result?.outcomes ?? []).reduce((s, o) => s + (o?.arbitrage?.expectedProfit > 0 ? o.arbitrage.expectedProfit : 0), 0)), valueClass: "text-[var(--status-positive)]", dim: !!result.expired },
                            { label: "Expiry", icon: <Clock className="w-3 h-3 text-[var(--status-warning)]" />, value: formatExpiry(result.expiryDate), valueClass: "text-[var(--text-primary)]", dim: false },
                          ] as const).map((chip) => (
                            <div key={chip.label} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] ${chip.dim ? "opacity-50" : ""}`}>
                              {chip.icon}
                              <span className="text-[10px] text-[var(--text-secondary)]">{chip.label}</span>
                              <span className={`text-xs font-bold ${chip.valueClass}`}>{chip.value}</span>
                            </div>
                          ))}

                          {/* Delete chip */}
                          <button
                            onClick={() => { if (confirm("Delete this market?")) deleteMarket(activeMarketId); }}
                            className="flex items-center justify-center px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-[var(--status-negative)]/10 transition-colors"
                            title="Delete market"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-[var(--text-secondary)] hover:text-[var(--status-negative)]" />
                          </button>

                          {/* Edit chip */}
                          <button
                            onClick={() => setEditingMarketId(activeMarketId)}
                            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors ${
                              editingMarketId === activeMarketId
                                ? "border-[var(--status-positive)]/30 bg-[var(--status-positive)]/10 text-[var(--status-positive)]"
                                : "border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            }`}
                            title="Edit market metadata"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            <span className="text-[10px]">Edit</span>
                          </button>

                          {/* Coupling panel toggle */}
                          <button
                            onClick={() => setCouplingPanelOpen(v => !v)}
                            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors ${
                              couplingPanelOpen
                                ? "border-[var(--status-positive)]/30 bg-[var(--status-positive)]/10 text-[var(--status-positive)]"
                                : "border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            }`}
                            title="Toggle coupling panel"
                          >
                            <PanelRight className="w-3.5 h-3.5" />
                            <span className="text-[10px]">Couplings</span>
                          </button>
                        </div>
                      </>
                    )}

                    {/* Inline edit panel */}
                    {editingMarketId && activeMarketId === editingMarketId && (
                      <MarketEditPanel
                        market={savedMarkets.find(m => m.id === editingMarketId)!}
                        onSave={(updated) => {
                          updateMarketInState(updated);
                          setEditingMarketId(null);
                        }}
                        onCancel={() => setEditingMarketId(null)}
                      />
                    )}

                    {(result.kalshiCount === 0 || result.pmCount === 0 || result.matchedCount === 0 || result.expired || result.noPrices) && (
                      <div className={`rounded-xl border p-3 flex items-start gap-3 text-sm ${result.expired ? 'border-[var(--status-negative)]/30 bg-[var(--status-negative)]/10 text-[var(--status-negative)]' : 'border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 text-[var(--status-warning)]'}`}>
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <div className="space-y-1 flex-1">
                          <div className="font-semibold">{result.expired ? 'Market expired' : result.noPrices ? 'No live prices' : 'Market data warning'}</div>
                          <div className="text-xs text-[var(--text-secondary)]">
                            {result.expired && <span className="mr-3">This market has expired. Data is no longer being captured or updated — prices and arbitrage calculations are frozen and no longer valid.</span>}
                            {result.noPrices && <span className="mr-3">No live prices available. Refresh or check the market URLs.</span>}
                            {!result.expired && !result.noPrices && result.kalshiCount === 0 && <span className="mr-3">Kalshi returned 0 open markets.</span>}
                            {!result.expired && !result.noPrices && result.pmCount === 0 && <span className="mr-3">Polymarket returned 0 markets.</span>}
                            {!result.expired && !result.noPrices && result.kalshiCount > 0 && result.pmCount > 0 && result.matchedCount === 0 && <span className="mr-3">No matched pairs found. Manual matching may be needed.</span>}
                          </div>
                          {/* UI-17: Red box (expired) — action buttons clickable */}
                          {result.expired && activeMarketId && (
                            <div className="flex items-center gap-2 mt-2">
                              <button
                                onClick={() => {
                                  const market = savedMarkets.find(m => m.id === activeMarketId);
                                  if (market) handleQuickPricesRefresh(activeMarketId, false);
                                }}
                                disabled={loading}
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--status-negative)]/30 bg-[var(--status-negative)]/10 text-[var(--status-negative)] text-[11px] font-medium hover:bg-[var(--status-negative)]/20 transition-colors disabled:opacity-50"
                                title="Re-scan this expired market"
                              >
                                <RefreshCw className="w-3 h-3" />
                                Re-scan
                              </button>
                              <button
                                onClick={() => setMatchMode("manual")}
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--status-negative)]/30 bg-[var(--status-negative)]/10 text-[var(--status-negative)] text-[11px] font-medium hover:bg-[var(--status-negative)]/20 transition-colors"
                                title="Switch to manual matching mode"
                              >
                                <Link2 className="w-3 h-3" />
                                Manual Match
                              </button>
                              <button
                                onClick={() => { if (confirm("Delete this market?")) deleteMarket(activeMarketId); }}
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--status-negative)]/30 bg-[var(--status-negative)]/10 text-[var(--status-negative)] text-[11px] font-medium hover:bg-[var(--status-negative)]/20 transition-colors"
                                title="Delete this market"
                              >
                                <Trash2 className="w-3 h-3" />
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Stake Calculator */}
                    {!result.expired && !result.noPrices && result.matchedCount > 0 && result.outcomes && (
                      <StakeCalculator
                        suggestions={result.outcomes
                          .filter(o => o.arbitrage && o.arbitrage.expectedProfit > 0)
                          .map(o => ({
                            artist: o.artist,
                            strategy: o.arbitrage.strategy,
                            kalshiStake: o.arbitrage.kalshiStake,
                            pmStake: o.arbitrage.pmStake,
                            totalStake: o.arbitrage.kalshiStake + o.arbitrage.pmStake,
                            expectedProfit: o.arbitrage.expectedProfit,
                            roiPct: o.arbitrage.roiPct,
                            apyPct: o.arbitrage.apyPct,
                          }))}
                        defaultCapital={capital}
                        onCapitalChange={setCapital}
                      />
                    )}

                    {/* View toggle: outcome table <-> 1on1 bookmaker view */}
                    {!result.expired && !result.noPrices && result.matchedCount > 0 && (
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setBookmakerView(false)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              !bookmakerView
                                ? "bg-[var(--status-positive)]/15 text-[var(--status-positive)] ring-1 ring-[var(--status-positive)]/30"
                                : "bg-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            }`}
                          >
                            <Rows3 className="w-3.5 h-3.5" /> Outcomes Table
                          </button>
                          <button
                            onClick={() => setBookmakerView(true)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              bookmakerView
                                ? "bg-[var(--status-positive)]/15 text-[var(--status-positive)] ring-1 ring-[var(--status-positive)]/30"
                                : "bg-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            }`}
                          >
                            <BarChart3 className="w-3.5 h-3.5" /> 1on1 Bookmaker
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Bookmaker 1on1 view */}
                    {result?.outcomes && bookmakerView && (
                      <Bookmaker1on1
                        outcomes={result.outcomes.map(o => ({
                          artist: o.artist,
                          platformA: o.kalshi ? {
                            yesBid: o.kalshi.yesBid,
                            yesAsk: o.kalshi.yesAsk,
                            noBid: o.kalshi.noBid,
                            noAsk: o.kalshi.noAsk,
                            lastPrice: o.kalshi.lastPrice,
                            lastUpdated: lastUpdated,
                          } : null,
                          platformB: o.polymarket ? {
                            yesPrice: o.polymarket.yesPrice,
                            noPrice: o.polymarket.noPrice,
                            bestBid: o.polymarket.bestBid,
                            bestAsk: o.polymarket.bestAsk,
                            lastTradePrice: o.polymarket.lastTradePrice,
                            lastUpdated: lastUpdated,
                          } : null,
                        }))}
                        lastUpdated={lastUpdated}
                        kalshiUrl={activeMarketId ? savedMarkets.find(m => m.id === activeMarketId)?.kalshiUrl : undefined}
                        pmUrl={activeMarketId ? savedMarkets.find(m => m.id === activeMarketId)?.polymarketUrl : undefined}
                        capital={capital}
                        liveMode={bookmakerView}
                      />
                    )}

                    {/* Outcome table — expanded log/detail area */}
                    {!bookmakerView && (result?.matchedCount ?? 0) > 0 && result?.outcomes && (
                      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] overflow-hidden overflow-x-auto" data-testid="outcome-table-scroll">
                        {/* Filter toggles */}
                        <div className="flex items-center gap-1 p-2 border-b border-[var(--border-subtle)]">
                          {(["all", "matched", "arb"] as const).map(mode => (
                            <button
                              key={mode}
                              onClick={() => setOutcomeFilter(mode)}
                              className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                                outcomeFilter === mode
                                  ? "bg-[var(--status-positive)]/20 text-[var(--status-positive)]"
                                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                              }`}
                            >
                              {mode === "all" ? "Show All" : mode === "matched" ? "Matched Only" : "Arb Only"}
                            </button>
                          ))}
                        </div>
                        <table className="w-full min-w-[1100px] text-sm">
                          <thead className="bg-[var(--surface-panel)] border-b border-[var(--border-subtle)]">
                            <tr className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wider">
                              <th className="sticky left-0 z-20 bg-[var(--surface-panel)] text-left px-4 py-3.5 font-medium">
                                <span className="inline-flex items-center gap-1">
                                  Outcome <HeaderInfo text="The market question being predicted (e.g. 'Will X win?'). Each outcome is a Yes/No pair you can bet on." />
                                </span>
                              </th>
                              <th className="text-right px-4 py-3.5 font-medium">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  <img src="/kalshi-icon.png" alt="Kalshi" className="w-3.5 h-3.5 rounded-sm" />
                                  Yes <HeaderInfo text="Kalshi Yes ask price — the cost to buy a Yes share on Kalshi. Lower = cheaper to buy Yes." />
                                </span>
                              </th>
                              <th className="text-right px-4 py-3.5 font-medium">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  <img src="/kalshi-icon.png" alt="Kalshi" className="w-3.5 h-3.5 rounded-sm" />
                                  No <HeaderInfo text="Kalshi No ask price — the cost to buy a No share on Kalshi. Lower = cheaper to buy No." />
                                </span>
                              </th>
                              <th className="text-right px-4 py-3.5 font-medium">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  <img src="/polymarket-icon.png" alt="Polymarket" className="w-3.5 h-3.5 rounded-sm" />
                                  Yes <HeaderInfo text="Polymarket Yes price — current best ask for a Yes share on Polymarket. Lower = cheaper to buy Yes." />
                                </span>
                              </th>
                              <th className="text-right px-4 py-3.5 font-medium">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  <img src="/polymarket-icon.png" alt="Polymarket" className="w-3.5 h-3.5 rounded-sm" />
                                  No <HeaderInfo text="Polymarket No price — current best ask for a No share on Polymarket. Lower = cheaper to buy No." />
                                </span>
                              </th>
                              <th onClick={() => toggleOutcomeSort("roi")} className="text-right px-4 py-3.5 font-medium cursor-pointer select-none hover:text-[var(--text-primary)] transition-colors">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  ROI <HeaderInfo text="Return on Investment — net profit as a percentage of total stake, after Kalshi and Polymarket trading fees.\nExample: $2 profit on $100 stake = 2% ROI." />
                                  <span className={`text-[8px] transition-opacity ${outcomeSort === "roi" ? "opacity-100 text-[var(--status-positive)]" : "opacity-0"}`}>
                                    {outcomeSort === "roi" && outcomeSortDir === "asc" ? "▲" : "▼"}
                                  </span>
                                </span>
                              </th>
                              <th onClick={() => toggleOutcomeSort("apy")} className="text-right px-4 py-3.5 font-medium cursor-pointer select-none hover:text-[var(--text-primary)] transition-colors">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  APY <ApyHeaderInfo />
                                  <span className={`text-[8px] transition-opacity ${outcomeSort === "apy" ? "opacity-100 text-[var(--status-positive)]" : "opacity-0"}`}>
                                    {outcomeSort === "apy" && outcomeSortDir === "asc" ? "▲" : "▼"}
                                  </span>
                                </span>
                              </th>
                              <th onClick={() => toggleOutcomeSort("profit")} className="text-right px-4 py-3.5 font-medium cursor-pointer select-none hover:text-[var(--text-primary)] transition-colors">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  Profit <HeaderInfo text="Net profit in dollars for this arbitrage opportunity, after all trading fees on both Kalshi and Polymarket.\nThis is the absolute dollar amount you'd earn from the arb trade at the current prices and stake." />
                                  <span className={`text-[8px] transition-opacity ${outcomeSort === "profit" ? "opacity-100 text-[var(--status-positive)]" : "opacity-0"}`}>
                                    {outcomeSort === "profit" && outcomeSortDir === "asc" ? "▲" : "▼"}
                                  </span>
                                </span>
                              </th>
                              <th className="text-right px-4 py-3.5 font-medium">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  <HeaderInfo text="Orderbook depth heatmap: how much capital can be deployed at the current prices.\nGreen = deep orderbook (large fills won't move the price). Red = thin orderbook (large fills will move the price against you).\nThe colored bars show available liquidity at each price level." />
                                  Depth
                                </span>
                              </th>
                              <th className="text-right px-4 py-3.5 font-medium">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  <HeaderInfo text="Recent arbitrage history for this market: spread snapshots over time showing whether the arb opportunity is widening, narrowing, or stable.\nEach bar represents a past scan. Taller = wider spread = more profitable." />
                                  Arbitrage History
                                </span>
                              </th>
                              <th className="text-right px-4 py-3.5 font-medium">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  <HeaderInfo text="Per-episode ROI trajectory: is THIS specific arb opportunity peaking or fading?\nThe curve shows how ROI has evolved over the market's lifetime.\nA rising curve means the arb is getting better; a falling curve means it's drying up." />
                                  Decay
                                </span>
                              </th>
                              <th className="text-left px-4 py-3.5 font-medium">
                                <span className="inline-flex items-center gap-1">
                                  Arb Type <HeaderInfo text="Color-coded arb type badge. Click a row to expand full leg breakdown with stakes, fees, and execution details." />
                                </span>
                              </th>
                            </tr>
                          </thead>
                          <OutcomeTableBody
                            outcomes={result.outcomes}
                            expandedArtist={expandedArtist}
                            setExpandedArtist={setExpandedArtist}
                            formatCurrency={formatCurrency}
                            formatPercent={formatPercent}
                            priceChanges={priceChanges}
                            filterMode={outcomeFilter}
                            marketTitle={result.eventTitle}
                            marketId={activeMarketId ?? undefined}
                            marketExpiryDate={result.expiryDate}
                            sortField={outcomeSort}
                            sortDir={outcomeSortDir}
                            scanTime={lastScanTimestamp ?? undefined}
                          />
                        </table>
                      </div>
                    )}

                    {/* UI-16b: Arb Opportunities — always-visible section below outcomes table */}
                    {result && !result.expired && (
                      <ArbOpportunitiesPanel
                        outcomes={result.outcomes}
                        marketId={activeMarketId ?? undefined}
                        formatCurrency={formatCurrency}
                        marketExpiryDate={result.expiryDate}
                        category={savedMarkets.find((market) => market.id === activeMarketId)?.category}
                        marketTitle={result.eventTitle}
                      />
                    )}

                    {/* HOOKUP-07: historical spread chart for the active saved market */}
                    {activeMarketId && result && !result.expired && (
                      <HistoricalSpreadChart
                        marketId={activeMarketId}
                        outcomeArtists={(result.outcomes ?? [])
                          .filter((o: UnifiedOutcome) => o.kalshi && o.polymarket)
                          .map((o: UnifiedOutcome) => o.artist)}
                        currentAvgRoi={(() => {
                          const rois = (result.outcomes ?? [])
                            .filter((o: UnifiedOutcome) => o.kalshi && o.polymarket)
                            .map((o: UnifiedOutcome) => o.arbitrage?.roiPct ?? 0);
                          return rois.length ? rois.reduce((s: number, r: number) => s + r, 0) / rois.length : undefined;
                        })()}
                        currentRoi={(() => {
                          const rois = (result.outcomes ?? [])
                            .filter((o: UnifiedOutcome) => o.kalshi && o.polymarket)
                            .map((o: UnifiedOutcome) => o.arbitrage?.roiPct ?? 0);
                          return rois.length ? Math.max(...rois) : undefined;
                        })()}
                      />
                    )}

                    {/* Manual matching panel — two-list pairing interface */}
                    {matchMode === "manual" && result && (() => {
                      const marketCouplings = manualMatches.filter(mm => {
                        const kMatch = result.outcomes?.some((o: UnifiedOutcome) =>
                          o.kalshi && o.kalshi.ticker === mm.kalshiTicker
                        );
                        const pmMatch = result.outcomes?.some((o: UnifiedOutcome) =>
                          o.polymarket && o.polymarket.conditionId === mm.pmConditionId
                        );
                        return kMatch || pmMatch;
                      });
                      return (
                        <ManualMatchPanel
                          unmatchedKalshi={result.unmatchedKalshi}
                          unmatchedPolymarket={result.unmatchedPolymarket}
                          activeMatches={marketCouplings.map(mm => ({
                            id: mm.id,
                            kalshiTicker: mm.kalshiTicker,
                            kalshiTitle: mm.kalshiTitle,
                            pmConditionId: mm.pmConditionId,
                            pmTitle: mm.pmTitle,
                          }))}
                          kalshiUrl={kalshiUrl}
                          polymarketUrl={pmUrl}
                          onPair={(kalshiTicker, pmConditionId, kalshiTitle, pmTitle) => {
                            onCreateMatch(kalshiTicker, pmConditionId, kalshiTitle, pmTitle);
                          }}
                          onUnpair={(matchId) => {
                            onDeleteMatch(matchId);
                            if (kalshiUrlRef.current && pmUrlRef.current) {
                              handleScanWithUrls(kalshiUrlRef.current, pmUrlRef.current, true);
                            }
                          }}
                        />
                      );
                    })()}

                    {/* Auto mode: Coupling suggestions for unmatched markets */}
                    {matchMode === "auto" && result.unmatchedKalshi.length > 0 && result.unmatchedPolymarket.length > 0 && (
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

                    {/* Auto mode: Active couplings for this market — with unlink capability */}
                    {matchMode === "auto" && manualMatches.length > 0 && (() => {
                      const marketCouplings = manualMatches.filter(mm => {
                        const kMatch = result.outcomes?.some((o: UnifiedOutcome) =>
                          o.kalshi && o.kalshi.ticker === mm.kalshiTicker
                        );
                        const pmMatch = result.outcomes?.some((o: UnifiedOutcome) =>
                          o.polymarket && o.polymarket.conditionId === mm.pmConditionId
                        );
                        return kMatch || pmMatch;
                      });
                      if (marketCouplings.length === 0) return null;
                      return (
                        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] overflow-hidden">
                          <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-subtle)]">
                            <Link2 className="w-4 h-4 text-[var(--status-positive)]" />
                            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Active Couplings</h3>
                            <span className="text-[10px] text-[var(--text-secondary)]">({marketCouplings.length})</span>
                          </div>
                          <div className="p-3 space-y-2">
                            {marketCouplings.map(mm => (
                              <div key={mm.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--surface-workspace)] border border-[var(--border-subtle)]">
                                <div className="flex-1 grid grid-cols-2 gap-2 text-xs">
                                  <div className="flex items-center gap-1 min-w-0">
                                    <img src="/kalshi-icon.png" alt="Kalshi" className="w-3 h-3 rounded-sm shrink-0" />
                                    <span className="text-[var(--text-primary)] truncate" title={mm.kalshiTitle}>{mm.kalshiTitle}</span>
                                  </div>
                                  <div className="flex items-center gap-1 min-w-0">
                                    <img src="/polymarket-icon.png" alt="Polymarket" className="w-3 h-3 rounded-sm shrink-0" />
                                    <span className="text-[var(--text-primary)] truncate" title={mm.pmTitle}>{mm.pmTitle}</span>
                                  </div>
                                </div>
                                <button
                                  onClick={() => {
                                    onDeleteMatch(mm.id);
                                    if (kalshiUrlRef.current && pmUrlRef.current) {
                                      handleScanWithUrls(kalshiUrlRef.current, pmUrlRef.current, true);
                                    }
                                  }}
                                  className="p-1.5 rounded-md bg-[var(--status-negative)]/10 hover:bg-[var(--status-negative)]/20 text-[var(--status-negative)] transition-colors"
                                  title="Unlink this coupling"
                                >
                                  <Unlink className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>

      {/* Coupling Panel — right-side expandable */}
      <CouplingPanel
        open={couplingPanelOpen}
        onClose={() => setCouplingPanelOpen(false)}
        outcomes={result?.outcomes ?? []}
        unmatchedKalshi={result?.unmatchedKalshi ?? []}
        unmatchedPolymarket={result?.unmatchedPolymarket ?? []}
        manualMatches={manualMatches}
        decoupledPairs={decoupledPairs}
        onRescan={() => {
          if (kalshiUrlRef.current && pmUrlRef.current) {
            handleScanWithUrls(kalshiUrlRef.current, pmUrlRef.current, true);
          }
        }}
        onDecouple={handleDecouple}
        onRemoveManualMatch={async (matchId: string) => {
          await fetch(`/api/manual-matches/${matchId}`, { method: "DELETE" });
          await loadManualMatches();
        }}
        onReconcple={handleRecouple}
        onCreateMatch={async (kt: string, pcid: string, ktTitle: string, pmTitle: string) => {
          await fetch("/api/manual-matches", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kalshiTicker: kt, pmConditionId: pcid, kalshiTitle: ktTitle, pmTitle }),
          });
          await loadManualMatches();
        }}
      />

    </div>
  );
}

