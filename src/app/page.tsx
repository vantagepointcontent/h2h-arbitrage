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
  Settings as SettingsIconLucide,
} from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { AlertSettingsPanel } from "@/components/AlertSystem";
import { CATEGORIES } from "@/lib/categories";

import dynamic from "next/dynamic";
// PERF-P1: lazy-load heavy conditionally-rendered components into separate chunks
const Bookmaker1on1 = dynamic(() => import("@/app/components/Bookmaker1on1").then(m => m.Bookmaker1on1), {
  loading: () => <div className="p-4 text-sm text-[#8A9BA8]">Loading...</div>,
  ssr: false,
});
const CouplingSuggestions = dynamic(() => import("@/app/components/CouplingSuggestions").then(m => m.CouplingSuggestions), {
  loading: () => <div className="p-4 text-sm text-[#8A9BA8]">Loading...</div>,
  ssr: false,
});
const DashboardPanel = dynamic(() => import("@/app/components/DashboardPanel"), { ssr: false });
const LiveScanPanel = dynamic(() => import("@/app/components/LiveScanPanel"), { ssr: false });
const LogsPanel = dynamic(() => import("@/app/components/LogsPanel"), { ssr: false });
const SettingsPanel = dynamic(() => import("@/app/components/SettingsPanel"), { ssr: false });
const CouplingPanel = dynamic(() => import("@/app/components/CouplingPanel"), { ssr: false });
const ManualMatchPanel = dynamic(() => import("@/app/components/ManualMatchPanel"), { ssr: false });
const ScanCategoryPicker = dynamic(() => import("@/app/components/ScanCategoryPicker"), { ssr: false });
const TradesPanel = dynamic(() => import("@/app/components/TradesPanel"), { ssr: false });
const ExecutionModeBadge = dynamic(() => import("@/app/components/ExecutionModeBadge"), { ssr: false });
const DualBrowserPanels = dynamic(() => import("@/components/EmbeddedBrowserPanel").then(m => m.DualBrowserPanels), { ssr: false });
const StakeCalculator = dynamic(() => import("@/components/StakeCalculator").then(m => m.StakeCalculator), { ssr: false });
import { OutcomeTableBody } from "@/app/components/OutcomeTableBody";
import { ArbOpportunitiesPanel } from "@/app/components/ArbOpportunitiesPanel";
import { ApyHeaderInfo, HeaderInfo } from "@/app/components/ApyTooltip";
const HistoricalSpreadChart = dynamic(() => import("@/app/components/HistoricalSpreadChart").then(m => m.HistoricalSpreadChart), { ssr: false });
import { saveSpread } from "@/lib/spreadHistory";


import { MarketSidebar } from "@/app/components/MarketSidebar";
import { OverviewPanel } from "@/app/components/OverviewPanel";
import { MarketFinderPanel } from "@/app/components/MarketFinderPanel";
import {
  getStoredMfCategories, persistMfCategories, getStoredMfExpiryDays, persistMfExpiryDays,
  getStoredMfSelectedIds, persistMfSelectedIds, getStoredFavoriteIds, persistFavoriteIds,
  getStoredCustomTitles, setCustomTitle,
  removeCustomTitle, MAX_CUSTOM_TITLE_LEN, getStoredMfAutoRefresh, persistMfAutoRefresh,
  getStoredSidebarOpen, persistSidebarOpen, getTotalProfitFromOutcomes, isMatched,
  formatCurrency, formatPercent, formatExpiry, timeUntilExpiry, isMarketExpired,
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
  const [capital, setCapital] = useState(1000);
  // PERF-P2: ref mirror so the 60s auto-refresh interval doesn't tear down
  // and restart on every capital keystroke (capital was in its deps).
  const capitalRef = useRef(capital);
  useEffect(() => { capitalRef.current = capital; }, [capital]);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [bgRefreshing, setBgRefreshing] = useState(false); // BUG-032
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
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
  const [viewMode, setViewMode] = useState<"scan" | "overview" | "marketfinder" | "live" | "dashboard" | "logs" | "settings" | "trades">("overview");

    // Dual panel layout + auto-refresh
  const [panelLayout, setPanelLayout] = useState<"sidebyside" | "stacked">("stacked");
  // Outcome table filter
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
          }
          // Background refresh (silent) — skip for expired markets
          if (!isExpired) {
            handleScanWithUrls(m.kalshiUrl, m.polymarketUrl, true);
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
      } else if (view === "logs") {
        setViewMode("logs");
      } else if (view === "settings") {
        setViewMode("settings");
      } else if (view === "trades") {
        setViewMode("trades");
      } else {
        setViewMode("dashboard");
      }
    };
    syncFromUrl();
  }, []);

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

  const handleScanWithUrls = async (kUrl: string, pUrl: string, silent = false) => {
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
        body: JSON.stringify({ kalshiUrl: kUrl, polymarketUrl: pUrl, capital: capital, skipAutoMatch: matchMode === "manual" }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult(data);
        setLastUpdated(new Date());
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
      const startUrl = ids
        ? `/api/saved-markets/refresh?start=true&ids=${encodeURIComponent(ids)}&_=${Date.now()}`
        : `/api/saved-markets/refresh?start=true&_=${Date.now()}`;
      const startRes = await fetch(startUrl, {
        headers: { 'Cache-Control': 'no-store' },
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
  const loadMarket = async (m: SavedMarket) => {
    setKalshiUrl(m.kalshiUrl);
    setPmUrl(m.polymarketUrl);
    setActiveMarketId(m.id);
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
    } else {
      // Expired market: show empty result with clear state
      setResult({
        eventTitle: m.eventTitle,
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
    }

    // Background refresh (silent) — skip for expired markets (BUG-033)
    if (!isExpired) {
      handleScanWithUrls(m.kalshiUrl, m.polymarketUrl, true);
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
  const [overviewExpiryFilter, setOverviewExpiryFilter] = useState<"all" | "lte7" | "lte14" | "lte30">("all");
  const [showExpired, setShowExpired] = useState(false);
  const [showArbOnly, setShowArbOnly] = useState(true);
  const [scanningAll, setScanningAll] = useState(false);
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

  // Outcome table sort — default APY desc (highest first)
  const [outcomeSort, setOutcomeSort] = useState<"roi" | "apy" | "profit">("apy");
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

    const market = savedMarketsRef.current.find(m => m.id === activeMarketId);
    if (!market) return;

    const iv = setInterval(() => {
      // Compare prices AFTER scan completes
      fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kalshiUrl: market.kalshiUrl, polymarketUrl: market.polymarketUrl, capital: capitalRef.current }),
      })
      .then(res => res.json())
      .then(data => {
        if (!data.outcomes) return;

        // Compare with previous prices
        const oldPrices = previousPricesRef.current;
        const changes = new Map<string, "up" | "down" | null>();
        const newPrices = new Map<string, { kYes: number; pYes: number }>();

        data.outcomes.forEach((o: UnifiedOutcome) => {
          if (o.kalshi && o.polymarket) {
            newPrices.set(o.artist, { kYes: o.kalshi.yesAsk, pYes: o.polymarket.yesPrice });

            const old = oldPrices.get(o.artist);
            if (old) {
              const kDiff = o.kalshi.yesAsk - old.kYes;
              const pDiff = o.polymarket.yesPrice - old.pYes;
              if (kDiff !== 0 || pDiff !== 0) {
                changes.set(o.artist, (kDiff + pDiff) > 0 ? "up" : "down");
              }
            }
          }
        });

        previousPricesRef.current = newPrices;
        setPriceChanges(changes);
        setResult(data);
        setLastUpdated(new Date());

        // Auto-clear blink after 3 seconds
        setTimeout(() => setPriceChanges(new Map()), 3000);
      })
      .catch(err => console.error("Auto-refresh failed:", err));
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
  const toggleOutcomeSort = (field: "roi" | "apy" | "profit") => {
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
    <div className="h-screen bg-[#0E1621] text-[#FFFFFF] flex flex-col overflow-hidden">
      {alertSettingsOpen && <AlertSettingsPanel onClose={() => setAlertSettingsOpen(false)} />}

      {/* Top nav bar */}
      <header className="sticky top-0 z-50 border-b border-[#182533] bg-[#0E1621]/90 backdrop-blur">
        <div className="flex items-center h-14 px-4 gap-3">
          <button onClick={() => setMobileMenuOpen(v => !v)} className="lg:hidden p-2 rounded-lg hover:bg-[#182533]">
            <Rows3 className="w-5 h-5" />
          </button>
          <button onClick={() => setSidebarOpen(v => !v)} className="hidden lg:flex p-2 rounded-lg hover:bg-[#182533] text-[#8A9BA8] hover:text-[#FFFFFF] transition-colors" title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}>
            <PanelLeft className={`w-5 h-5 transition-transform ${!sidebarOpen ? "rotate-180" : ""}`} />
          </button>
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-[#5DBE81]/15 border border-[#5DBE81]/30">
              <Radar className="w-4 h-4 text-[#5DBE81]" />
            </div>
            <h1 className="text-base font-bold tracking-tight">EdgeFinder</h1>
          </div>
          <ExecutionModeBadge />

          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setViewMode("live")} className={`p-2 rounded-lg hover:bg-[#182533] transition-colors ${viewMode === "live" ? "text-[#5DBE81] bg-[#5DBE81]/10" : "text-[#8A9BA8] hover:text-[#FFFFFF]"}`} title="Live WebSocket scan">
              <Activity className="w-4 h-4" />
            </button>
            <button onClick={() => setAlertSettingsOpen(true)} className="p-2 rounded-lg hover:bg-[#182533] text-[#8A9BA8] hover:text-[#FFFFFF]" title="Alert settings">
              <Bell className="w-4 h-4" />
            </button>
            <button onClick={goToSettings} className={`p-2 rounded-lg hover:bg-[#182533] transition-colors ${viewMode === "settings" ? "text-[#5DBE81] bg-[#5DBE81]/10" : "text-[#8A9BA8] hover:text-[#FFFFFF]"}`} title="App settings">
              <SettingsIconLucide className="w-4 h-4" />
            </button>
            <button onClick={() => theme.toggleTheme()} className="p-2 rounded-lg hover:bg-[#182533] text-[#8A9BA8] hover:text-[#FFFFFF]" title="Toggle theme">
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
          onGoTrades={goToTrades}
          favoriteIds={favoriteIds}
          onToggleFavorite={toggleFavorite}
          sidebarFavoritesOnly={sidebarFavoritesOnly}
          onToggleSidebarFavorites={() => setSidebarFavoritesOnly(v => !v)}
          mobileMenuOpen={mobileMenuOpen}
          onCloseMobileMenu={() => setMobileMenuOpen(false)}
        />
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto p-2 sm:p-4 md:p-6">
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
            ) : viewMode === "logs" ? (
              <LogsPanel />
            ) : viewMode === "settings" ? (
              <SettingsPanel />
            ) : viewMode === "trades" ? (
              <TradesPanel />
            ) : (
              <>
                {/* Scan inputs */}
                {!activeMarketId && (
                <div className="rounded-xl border border-[#182533] bg-[#17212B] p-3 sm:p-4 md:p-5 mb-4 sm:mb-6">
                  {/* FEAT-015: category picker — browse matched pairs instead of pasting URLs */}
                  <ScanCategoryPicker onPick={(k, pm) => { setKalshiUrl(k); setPmUrl(pm); }} />
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-4 mb-4">
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm font-medium text-[#8A9BA8]">
                        <Link2 className="w-4 h-4" /> Kalshi URL
                      </label>
                      <input
                        type="text"
                        value={kalshiUrl}
                        onChange={(e) => setKalshiUrl(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] placeholder-[#48555F] focus:outline-none focus:border-[#5DBE81] focus:ring-1 focus:ring-[#5DBE81]/30 transition-all"
                        placeholder="https://kalshi.com/markets/..."
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm font-medium text-[#8A9BA8]">
                        <Link2 className="w-4 h-4" /> Polymarket URL
                      </label>
                      <input
                        type="text"
                        value={pmUrl}
                        onChange={(e) => setPmUrl(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] placeholder-[#48555F] focus:outline-none focus:border-[#5DBE81] focus:ring-1 focus:ring-[#5DBE81]/30 transition-all"
                        placeholder="https://polymarket.com/event/..."
                      />
                    </div>
                  </div>

                  {/* Auto/Manual match toggle */}
                  <div className="flex items-center gap-2 mb-4 flex-col sm:flex-row">
                    <span className="text-xs text-[#8A9BA8]">Match Mode:</span>
                    <div className="flex rounded-lg bg-[#0E1621] border border-[#182533] p-0.5">
                      <button
                        onClick={() => setMatchMode("auto")}
                        className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                          matchMode === "auto"
                            ? "bg-[#5DBE81] text-black"
                            : "text-[#8A9BA8] hover:text-[#FFFFFF]"
                        }`}
                      >
                        Auto Match
                      </button>
                      <button
                        onClick={() => setMatchMode("manual")}
                        className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                          matchMode === "manual"
                            ? "bg-[#a855f7] text-white"
                            : "text-[#8A9BA8] hover:text-[#FFFFFF]"
                        }`}
                      >
                        Manual Match
                      </button>
                    </div>
                    {matchMode === "manual" && (
                      <span className="text-[10px] text-[#a855f7]/70">Link markets manually after scan</span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 flex-wrap">
                    <button onClick={() => handleScan(false)} disabled={loading} className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#5DBE81] text-black font-semibold text-sm hover:bg-[#4DA66E] transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scan className="w-4 h-4" />}
                      {loading ? "Scanning..." : "Scan Markets"}
                    </button>

                    {result && (
                      <button onClick={saveMarket} disabled={saving} className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#182533] border border-[#232E3C] text-[#FFFFFF] text-sm hover:bg-[#232E3C] transition-all disabled:opacity-50">
                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        {saving ? "Saving..." : "Save Market"}
                      </button>
                    )}

                    <div className="flex items-center gap-2 ml-auto">
                      <label className="text-xs text-[#8A9BA8]">Capital:</label>
                      <input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))} className="w-24 px-2 py-1.5 rounded-lg border border-[#232E3C] bg-[#0E1621] border border-[#232E3C] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]" />
                      <button
                        onClick={() => setCouplingPanelOpen(v => !v)}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors ${
                          couplingPanelOpen
                            ? "border-[#5DBE81]/30 bg-[#5DBE81]/10 text-[#5DBE81]"
                            : "border-[#182533] bg-[#121E2B] text-[#8A9BA8] hover:text-[#FFFFFF]"
                        }`}
                        title="Toggle coupling panel"
                      >
                        <PanelRight className="w-3.5 h-3.5" />
                        <span className="text-[10px]">Couplings</span>
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div className="mt-3 flex items-center gap-2 text-sm text-[#ef4444]">
                      <AlertCircle className="w-4 h-4" /> {error}
                    </div>
                  )}
                </div>
                )}

                {/* Loading state */}
                {loading && (
                  <div className="py-20 text-center text-sm text-[#8A9BA8]">
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
                          <h2 className="text-sm font-bold text-[#FFFFFF] truncate">{result.eventTitle}</h2>
                          {savedMarkets.find(m => m.id === activeMarketId)?.category && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-[#182533] text-[#8A9BA8]">
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
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#182533] bg-[#121E2B] hover:bg-[#182533] hover:border-[#5DBE81]/50 transition-colors"
                            title="Open Kalshi market"
                          >
                            <img src="/kalshi-icon.png" alt="Kalshi" className="w-4 h-4 rounded-sm" />
                            <span className="text-[10px] text-[#8A9BA8]">Kalshi</span>
                          </a>

                          {/* Polymarket link chip */}
                          <a
                            href={savedMarkets.find(m => m.id === activeMarketId)?.polymarketUrl || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#182533] bg-[#121E2B] hover:bg-[#182533] hover:border-[#a855f7]/50 transition-colors"
                            title="Open Polymarket"
                          >
                            <img src="/polymarket-icon.png" alt="Polymarket" className="w-4 h-4 rounded-sm" />
                            <span className="text-[10px] text-[#8A9BA8]">Polymarket</span>
                          </a>

                          {/* Refresh chip */}
                          <button
                            onClick={() => {
                              const market = savedMarkets.find(m => m.id === activeMarketId);
                              if (market) handleScanWithUrls(market.kalshiUrl, market.polymarketUrl);
                            }}
                            disabled={loading}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#182533] bg-[#121E2B] hover:bg-[#182533] transition-colors disabled:opacity-50"
                            title="Refresh"
                          >
                            {loading || bgRefreshing ? <Loader2 className="w-3 h-3 animate-spin text-[#5DBE81]" /> : <RefreshCw className="w-3 h-3 text-[#8A9BA8]" />}
                            <span className="text-[10px] text-[#FFFFFF]">{bgRefreshing ? (scanningAll && scanProgress.total > 0 ? `Refreshing ${scanProgress.current}/${scanProgress.total}…` : "Refreshing prices…") : lastUpdated ? Math.round((Date.now() - new Date(lastUpdated).getTime()) / 1000) + "s ago" : "—"}</span>
                          </button>

                          {/* Data chips (config-driven) */}
                          {([
                            { label: "Kalshi", icon: <img src="/kalshi-icon.png" alt="Kalshi" className="w-4 h-4 rounded-sm" />, value: String(result.kalshiCount), valueClass: "text-[#FFFFFF]", dim: false },
                            { label: "Polymarket", icon: <img src="/polymarket-icon.png" alt="Polymarket" className="w-4 h-4 rounded-sm" />, value: String(result.pmCount), valueClass: "text-[#FFFFFF]", dim: false },
                            { label: "Matched", icon: <div className="flex items-center justify-center w-4 h-4 rounded-sm bg-[#5DBE81]"><Check className="w-2.5 h-2.5 text-[#FFFFFF]" /></div>, value: String(result.matchedCount), valueClass: "text-[#FFFFFF]", dim: false },
                            { label: "Total Profit", icon: <TrendingUp className="w-3 h-3 text-[#5DBE81]" />, value: result.expired ? "—" : formatCurrency((result?.outcomes ?? []).reduce((s, o) => s + (o?.arbitrage?.expectedProfit > 0 ? o.arbitrage.expectedProfit : 0), 0)), valueClass: "text-[#5DBE81]", dim: !!result.expired },
                            { label: "Expiry", icon: <Clock className="w-3 h-3 text-[#facc15]" />, value: formatExpiry(result.expiryDate), valueClass: "text-[#FFFFFF]", dim: false },
                          ] as const).map((chip) => (
                            <div key={chip.label} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#182533] bg-[#121E2B] ${chip.dim ? "opacity-50" : ""}`}>
                              {chip.icon}
                              <span className="text-[10px] text-[#8A9BA8]">{chip.label}</span>
                              <span className={`text-xs font-bold ${chip.valueClass}`}>{chip.value}</span>
                            </div>
                          ))}

                          {/* Delete chip */}
                          <button
                            onClick={() => { if (confirm("Delete this market?")) deleteMarket(activeMarketId); }}
                            className="flex items-center justify-center px-2.5 py-1.5 rounded-lg border border-[#182533] bg-[#121E2B] hover:bg-[#ef4444]/10 transition-colors"
                            title="Delete market"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-[#8A9BA8] hover:text-[#ef4444]" />
                          </button>

                          {/* Coupling panel toggle */}
                          <button
                            onClick={() => setCouplingPanelOpen(v => !v)}
                            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors ${
                              couplingPanelOpen
                                ? "border-[#5DBE81]/30 bg-[#5DBE81]/10 text-[#5DBE81]"
                                : "border-[#182533] bg-[#121E2B] text-[#8A9BA8] hover:text-[#FFFFFF]"
                            }`}
                            title="Toggle coupling panel"
                          >
                            <PanelRight className="w-3.5 h-3.5" />
                            <span className="text-[10px]">Couplings</span>
                          </button>
                        </div>
                      </>
                    )}

                    {(result.kalshiCount === 0 || result.pmCount === 0 || result.matchedCount === 0 || result.expired || result.noPrices) && (
                      <div className={`rounded-xl border p-3 flex items-start gap-3 text-sm ${result.expired ? 'border-[#ef4444]/30 bg-[#ef4444]/10 text-[#ef4444]' : 'border-[#facc15]/30 bg-[#facc15]/10 text-[#facc15]'}`}>
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <div className="space-y-1 flex-1">
                          <div className="font-semibold">{result.expired ? 'Market expired' : result.noPrices ? 'No live prices' : 'Market data warning'}</div>
                          <div className="text-xs text-[#8A9BA8]">
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
                                  if (market) handleScanWithUrls(market.kalshiUrl, market.polymarketUrl);
                                }}
                                disabled={loading}
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 text-[#ef4444] text-[11px] font-medium hover:bg-[#ef4444]/20 transition-colors disabled:opacity-50"
                                title="Re-scan this expired market"
                              >
                                <RefreshCw className="w-3 h-3" />
                                Re-scan
                              </button>
                              <button
                                onClick={() => setMatchMode("manual")}
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 text-[#ef4444] text-[11px] font-medium hover:bg-[#ef4444]/20 transition-colors"
                                title="Switch to manual matching mode"
                              >
                                <Link2 className="w-3 h-3" />
                                Manual Match
                              </button>
                              <button
                                onClick={() => { if (confirm("Delete this market?")) deleteMarket(activeMarketId); }}
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 text-[#ef4444] text-[11px] font-medium hover:bg-[#ef4444]/20 transition-colors"
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
                                ? "bg-[#5DBE81]/15 text-[#5DBE81] ring-1 ring-[#5DBE81]/30"
                                : "bg-[#182533] text-[#8A9BA8] hover:text-[#FFFFFF]"
                            }`}
                          >
                            <Rows3 className="w-3.5 h-3.5" /> Outcomes Table
                          </button>
                          <button
                            onClick={() => setBookmakerView(true)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              bookmakerView
                                ? "bg-[#5DBE81]/15 text-[#5DBE81] ring-1 ring-[#5DBE81]/30"
                                : "bg-[#182533] text-[#8A9BA8] hover:text-[#FFFFFF]"
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
                      <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden overflow-x-auto">
                        {/* Filter toggles */}
                        <div className="flex items-center gap-1 p-2 border-b border-[#182533]">
                          {(["all", "matched", "arb"] as const).map(mode => (
                            <button
                              key={mode}
                              onClick={() => setOutcomeFilter(mode)}
                              className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                                outcomeFilter === mode
                                  ? "bg-[#5DBE81]/20 text-[#5DBE81]"
                                  : "text-[#8A9BA8] hover:text-[#FFFFFF]"
                              }`}
                            >
                              {mode === "all" ? "Show All" : mode === "matched" ? "Matched Only" : "Arb Only"}
                            </button>
                          ))}
                        </div>
                        <table className="w-full text-sm">
                          <thead className="bg-[#17212B] border-b border-[#182533]">
                            <tr className="text-[10px] text-[#8A9BA8] uppercase tracking-wider">
                              <th className="text-left px-4 py-3.5 font-medium">
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
                              <th onClick={() => toggleOutcomeSort("roi")} className="text-right px-4 py-3.5 font-medium cursor-pointer select-none hover:text-[#FFFFFF] transition-colors">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  ROI <HeaderInfo text="Return on Investment — net profit as a percentage of total stake, after Kalshi and Polymarket trading fees.\nExample: $2 profit on $100 stake = 2% ROI." />
                                  <span className={`text-[8px] transition-opacity ${outcomeSort === "roi" ? "opacity-100 text-[#5DBE81]" : "opacity-0"}`}>
                                    {outcomeSort === "roi" && outcomeSortDir === "asc" ? "▲" : "▼"}
                                  </span>
                                </span>
                              </th>
                              <th onClick={() => toggleOutcomeSort("apy")} className="text-right px-4 py-3.5 font-medium cursor-pointer select-none hover:text-[#FFFFFF] transition-colors">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  APY <ApyHeaderInfo />
                                  <span className={`text-[8px] transition-opacity ${outcomeSort === "apy" ? "opacity-100 text-[#5DBE81]" : "opacity-0"}`}>
                                    {outcomeSort === "apy" && outcomeSortDir === "asc" ? "▲" : "▼"}
                                  </span>
                                </span>
                              </th>
                              <th onClick={() => toggleOutcomeSort("profit")} className="text-right px-4 py-3.5 font-medium cursor-pointer select-none hover:text-[#FFFFFF] transition-colors">
                                <span className="inline-flex items-center gap-1 flex-row-reverse">
                                  Profit <HeaderInfo text="Net profit in dollars for this arbitrage opportunity, after all trading fees on both Kalshi and Polymarket.\nThis is the absolute dollar amount you'd earn from the arb trade at the current prices and stake." />
                                  <span className={`text-[8px] transition-opacity ${outcomeSort === "profit" ? "opacity-100 text-[#5DBE81]" : "opacity-0"}`}>
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
                          />
                        </table>
                      </div>
                    )}

                    {/* UI-16b: Arb Opportunities — always-visible section below outcomes table */}
                    {result && !result.expired && (
                      <ArbOpportunitiesPanel
                        outcomes={result.outcomes}
                        formatCurrency={formatCurrency}
                        marketExpiryDate={result.expiryDate}
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
                        <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
                          <div className="flex items-center gap-2 px-4 py-3 border-b border-[#182533]">
                            <Link2 className="w-4 h-4 text-[#5DBE81]" />
                            <h3 className="text-sm font-semibold text-[#FFFFFF]">Active Couplings</h3>
                            <span className="text-[10px] text-[#8A9BA8]">({marketCouplings.length})</span>
                          </div>
                          <div className="p-3 space-y-2">
                            {marketCouplings.map(mm => (
                              <div key={mm.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533]">
                                <div className="flex-1 grid grid-cols-2 gap-2 text-xs">
                                  <div className="flex items-center gap-1 min-w-0">
                                    <img src="/kalshi-icon.png" alt="Kalshi" className="w-3 h-3 rounded-sm shrink-0" />
                                    <span className="text-[#FFFFFF] truncate" title={mm.kalshiTitle}>{mm.kalshiTitle}</span>
                                  </div>
                                  <div className="flex items-center gap-1 min-w-0">
                                    <img src="/polymarket-icon.png" alt="Polymarket" className="w-3 h-3 rounded-sm shrink-0" />
                                    <span className="text-[#FFFFFF] truncate" title={mm.pmTitle}>{mm.pmTitle}</span>
                                  </div>
                                </div>
                                <button
                                  onClick={() => {
                                    onDeleteMatch(mm.id);
                                    if (kalshiUrlRef.current && pmUrlRef.current) {
                                      handleScanWithUrls(kalshiUrlRef.current, pmUrlRef.current, true);
                                    }
                                  }}
                                  className="p-1.5 rounded-md bg-[#ef4444]/10 hover:bg-[#ef4444]/20 text-[#ef4444] transition-colors"
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

                    {/* Embedded platform browsers */}
                    <DualBrowserPanels
                      kalshiUrl={kalshiUrl}
                      pmUrl={pmUrl}
                      layout={panelLayout}
                      onLayoutChange={setPanelLayout}
                    />
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

