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
} from "lucide-react";
import { DateTimePicker } from "@/components/DateTimePicker";

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
  artist: string;
  yesAsk: number;
  noAsk: number;
}

interface UnmatchedPolymarket {
  conditionId: string;
  marketId: string;
  title: string;
  yesPrice: number;
  noPrice: number;
}

interface ManualMatch {
  id: string;
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle: string;
  pmTitle: string;
  kalshiUrl?: string;
  polymarketUrl?: string;
  createdAt: string;
}

interface ScanResult {
  eventTitle: string;
  kalshiEventTicker: string;
  pmEventSlug: string;
  pmEventId: string;
  expiryDate?: string | null;
  kalshiCount: number;
  pmCount: number;
  matchedCount: number;
  kalshiRawCount?: number;
  pmRawCount?: number;
  pmFilteredCount?: number;
  kalshiFetchSource?: string;
  clobHitCount?: number;
  clobMissCount?: number;
  outcomes: UnifiedOutcome[];
  unmatchedKalshi: UnmatchedKalshi[];
  unmatchedPolymarket: UnmatchedPolymarket[];
}

interface SavedMarket {
  id: string;
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  category?: string;
  createdAt: string;
  expiryDate?: string | null;
  lastScanResult?: {
    bestRoiPct: number;
    bestProfit: number;
    strategy: string;
    matchedCount: number;
    kalshiCount: number;
    pmCount: number;
    scannedAt: string;
    totalStake?: number;
    allArbs?: {
      artist: string;
      roiPct: number;
      expectedProfit: number;
      strategy: string;
      totalStake?: number;
    }[];
  } | null;
}

type OverviewSort = "expiry" | "roi" | "name" | "apy";

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

  const [savedMarkets, setSavedMarkets] = useState<SavedMarket[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeMarketId, setActiveMarketId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"scan" | "overview" | "marketfinder">("overview");

  // Refs for values used inside useCallback — avoids stale closures and dependency-triggered re-renders
  const savedMarketsRef = useRef<SavedMarket[]>(savedMarkets);
  const kalshiUrlRef = useRef(kalshiUrl);
  const pmUrlRef = useRef(pmUrl);
  const activeMarketIdRef = useRef(activeMarketId);

  // Keep refs in sync with state
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
        // Default: overview
        stopPolling();
        setViewMode("overview");
        setActiveMarketId(null);
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
          setResult(null);
          previousPricesRef.current = new Map();
          setPriceChanges(new Map());
          handleScanWithUrls(m.kalshiUrl, m.polymarketUrl);
          return;
        }
      }

      if (view === "overview" || view === "marketfinder") {
        setViewMode(view);
        stopPolling();
        setActiveMarketId(null);
        window.history.replaceState({ view }, "", `/?view=${view}`);
        return;
      }

      // Default
      setViewMode("overview");
      stopPolling();
      setActiveMarketId(null);
      window.history.replaceState({ view: "overview" }, "", "/?view=overview");
    };

    syncFromUrl();
  }, []);

  // Save modal state
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveExpiry, setSaveExpiry] = useState<string | null>(null);
  const [saveCategory, setSaveCategory] = useState("");

  // Edit modal state
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editMarketId, setEditMarketId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editExpiry, setEditExpiry] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState("");

  // Sidebar category filter
  const [sidebarCategoryFilter, setSidebarCategoryFilter] = useState<string>("");
  const [sidebarSearch, setSidebarSearch] = useState<string>("");
  const allCategories = Array.from(new Set(savedMarkets.map(m => m.category).filter((c): c is string => !!c))).sort();

  // Overview sort + expiry filter
  const [overviewSort, setOverviewSort] = useState<OverviewSort>("expiry");
  const [overviewSortDir, setOverviewSortDir] = useState<"asc" | "desc">("asc");
  const [overviewLayout, setOverviewLayout] = useState<"grid" | "table">("grid");
  const [overviewExpiryFilter, setOverviewExpiryFilter] = useState<"all" | "lte7" | "lte14" | "lte30">("all");
  const [hideUnmatched, setHideUnmatched] = useState(false);

  const [scanningAll, setScanningAll] = useState(false);
  const [scanAllError, setScanAllError] = useState<string>("");

  // MarketFinder state
  const [mfMarkets, setMfMarkets] = useState<any[]>([]);
  const [mfLoading, setMfLoading] = useState(false);
  const [mfSyncing, setMfSyncing] = useState(false);
  const [mfError, setMfError] = useState("");
  const [mfLastSync, setMfLastSync] = useState<any>(null);
  const [mfSavingIds, setMfSavingIds] = useState<Set<string>>(new Set());

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

  // Polling timer
  useEffect(() => {
    const iv = setInterval(() => setPollTimer(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const loadSavedMarkets = async () => {
    try {
      const res = await fetch("/api/saved-markets");
      if (res.ok) {
        const data = await res.json();
        setSavedMarkets(data.markets || []);
        return data.markets || [];
      }
    } catch {}
    return [];
  };

  const loadManualMatches = async () => {
    try {
      const res = await fetch("/api/manual-matches");
      if (res.ok) {
        const data = await res.json();
        setManualMatches(data.matches || []);
      }
    } catch {}
  };

  // Scan ALL saved markets sequentially (manual trigger from Overview)
  const scanAllMarkets = async () => {
    if (scanningAll) return;
    setScanningAll(true);
    setScanAllError("");
    const failed: string[] = [];

    for (const market of savedMarketsRef.current) {
      try {
        await fetch(`/api/scan?_=${Date.now()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kalshiUrl: market.kalshiUrl,
            polymarketUrl: market.polymarketUrl,
          }),
        });
      } catch {
        failed.push(market.eventTitle);
      }
    }

    await loadSavedMarkets();
    setScanningAll(false);
    if (failed.length > 0) {
      setScanAllError(`${failed.length} market(s) failed to scan.`);
      setTimeout(() => setScanAllError(""), 4000);
    }
  };

  const saveCurrentMarket = async () => {
    if (!result) return;
    setSaving(true);
    try {
      const res = await fetch("/api/saved-markets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kalshiUrl,
          polymarketUrl: pmUrl,
          eventTitle: saveName || result.eventTitle,
          category: saveCategory,
          expiryDate: saveExpiry,
        }),
      });
      if (res.ok) {
        await loadSavedMarkets();
        setSaveModalOpen(false);
        setSaveName("");
        setSaveCategory("");
        setSaveExpiry(null);
      } else {
        const data = await res.json().catch(() => ({ error: "Save failed" }));
        setError(data.error || "Save failed");
      }
    } catch (e: any) {
      setError("Failed to save: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const updateMarketMeta = async (id: string, updates: { eventTitle?: string; expiryDate?: string | null; category?: string }) => {
    try {
      await fetch("/api/saved-markets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...updates }),
      });
      await loadSavedMarkets();
    } catch {}
  };

  const deleteMarket = async (id: string) => {
    try {
      const res = await fetch(`/api/saved-markets?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setSavedMarkets((prev) => prev.filter((m) => m.id !== id));
        if (activeMarketId === id) {
          setActiveMarketId(null);
          stopPolling();
          setResult(null);
        }
      }
    } catch {}
  };

  const createManualMatch = async (kalshiTicker: string, pmConditionId: string, kalshiTitle?: string, pmTitle?: string) => {
    try {
      const res = await fetch("/api/manual-matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kalshiTicker,
          pmConditionId,
          kalshiTitle: kalshiTitle || kalshiTicker,
          pmTitle: pmTitle || pmConditionId,
          kalshiUrl,
          polymarketUrl: pmUrl,
        }),
      });
      if (res.ok) {
        await loadManualMatches();
        setSelectedKalshi(null);
        setSelectedPM(null);
        setManualMatchMsg("✓ Linked!");
        setTimeout(() => setManualMatchMsg(""), 2000);
        await scan(false);
      } else {
        const data = await res.json();
        setManualMatchMsg(data.error || "Failed to link");
      }
    } catch (e: any) {
      setManualMatchMsg(e.message || "Error");
    }
  };

  const deleteManualMatch = async (id: string) => {
    try {
      const res = await fetch(`/api/manual-matches?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        await loadManualMatches();
        await scan(false);
      }
    } catch {}
  };

  const loadMarket = (market: SavedMarket) => {
    stopPolling();               // ← stop old poll first
    setKalshiUrl(market.kalshiUrl);
    setPmUrl(market.polymarketUrl);
    setActiveMarketId(market.id);
    setViewMode("scan");
    setError("");
    setResult(null);            // ← wipe old result immediately
    previousPricesRef.current = new Map(); // ← reset price tracking for new market
    setPriceChanges(new Map());            // ← clear any stale flash indicators
    // Push history state so back button works
    window.history.pushState({ view: "scan", marketId: market.id }, "", `/?view=scan&id=${market.id}`);
    // Use refs to ensure URLs are set before scan fires
    kalshiUrlRef.current = market.kalshiUrl;
    pmUrlRef.current = market.polymarketUrl;
    activeMarketIdRef.current = market.id;
    handleScanWithUrls(market.kalshiUrl, market.polymarketUrl);
  };

  const goToNewScan = () => {
    setKalshiUrl("");
    setPmUrl("");
    setResult(null);
    setActiveMarketId(null);
    setError("");
    previousPricesRef.current = new Map();
    setPriceChanges(new Map());
    stopPolling();
    setViewMode("scan");
    window.history.pushState({ view: "scan" }, "", "/?view=scan");
  };

  const goToOverview = () => {
    stopPolling();
    setViewMode("overview");
    setActiveMarketId(null);
    window.history.pushState({ view: "overview" }, "", "/?view=overview");
  };

  const goToMarketFinder = () => {
    stopPolling();
    setViewMode("marketfinder");
    setActiveMarketId(null);
    window.history.pushState({ view: "marketfinder" }, "", "/?view=marketfinder");
  };

  const scan = useCallback(async (silent = false, overrideKUrl?: string, overridePmUrl?: string) => {
    if (activeScanRef.current) return false;
    activeScanRef.current = true;
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/scan?_=${Date.now()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({
          kalshiUrl: overrideKUrl ?? kalshiUrlRef.current,
          polymarketUrl: overridePmUrl ?? pmUrlRef.current,
        }),
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const newChanges = new Map<string, "up" | "down" | null>();
      const newPrev = new Map<string, { kYes: number; pYes: number }>();
      if (data.outcomes) {
        for (const o of data.outcomes) {
          const key = o.artist;
          const currK = o.kalshi?.yesBid ?? null;
          const currP = o.polymarket?.yesPrice ?? null;
          const prev = previousPricesRef.current.get(key);
          if (prev) {
            let changed: "up" | "down" | null = null;
            if (currK !== null && Math.abs(currK - prev.kYes) > 0.001)
              changed = currK > prev.kYes ? "up" : "down";
            else if (currP !== null && Math.abs(currP - prev.pYes) > 0.001)
              changed = currP > prev.pYes ? "up" : "down";
            if (changed) newChanges.set(key, changed);
          }
          newPrev.set(key, { kYes: currK ?? 0, pYes: currP ?? 0 });
        }
      }
      if (newChanges.size > 0) {
        setPriceChanges(new Map(newChanges));
        setTimeout(() => setPriceChanges(new Map()), 3000);
      }
      previousPricesRef.current = newPrev;
      setResult(data);
      if (activeMarketIdRef.current && data.expiryDate) {
        const activeMarket = savedMarketsRef.current.find(m => m.id === activeMarketIdRef.current);
        if (activeMarket && !activeMarket.expiryDate) {
          updateMarketMeta(activeMarketIdRef.current, { expiryDate: data.expiryDate });
        }
      }
      setLastUpdated(new Date());
      // Only refresh manual matches on the first scan, not every poll tick
      if (!silent) loadManualMatches();
      setLastScanTime(data._ts || Date.now());
      return true;
    } catch (err: any) {
      if (!silent) setError(err.message || "Scan failed");
      return false;
    } finally {
      activeScanRef.current = false;
      if (!silent) setLoading(false);
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingActiveRef.current) return; // already polling — don't double-start
    pollingActiveRef.current = true;
    setIsPolling(true);
    if (pollRef.current) clearTimeout(pollRef.current);

    const runPoll = async () => {
      if (!pollingActiveRef.current) return;
      const started = Date.now();
      await scan(true);
      const elapsed = Date.now() - started;
      if (pollingActiveRef.current) {
        pollRef.current = setTimeout(runPoll, Math.max(1000, 5000 - elapsed));
      }
    };

    pollRef.current = setTimeout(runPoll, 3000); // first poll after 3s
  }, [scan]);

  const stopPolling = useCallback(() => {
    pollingActiveRef.current = false;
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    setIsPolling(false);
  }, []);

  useEffect(() => {
    return () => {
      pollingActiveRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const handleScan = async (silent = false) => {
    await scan(silent);
    if (!silent) startPolling();
  };

  const handleScanWithUrls = async (kUrl: string, pUrl: string) => {
    await scan(false, kUrl, pUrl);
    startPolling();
  };

  const formatPrice = (p: number) => `${(p * 100).toFixed(1)}¢`;

  const kalshiDeepLink = (ticker: string) => `https://kalshi.com/markets/${ticker}`;
  const pmDeepLink = (slug: string) => `https://polymarket.com/event/${slug}`;

  const sortedData = (() => {
    if (!result) return [];
    let arr = result.outcomes.slice();
    if (hideUnmatched) {
      arr = arr.filter(o => !!o.kalshi && !!o.polymarket);
    }
    if (sortField === "roi") {
      arr.sort((a, b) => {
        const aRoi = a.arbitrage?.roiPct ?? -Infinity;
        const bRoi = b.arbitrage?.roiPct ?? -Infinity;
        return sortDirection === "desc" ? bRoi - aRoi : aRoi - bRoi;
      });
    }
    return arr;
  })();

  const openSaveModal = () => {
    if (!result) return;
    setSaveName(result.eventTitle);
    setSaveExpiry(result.expiryDate || null);
    setSaveCategory("");
    setSaveModalOpen(true);
  };

  const openEditModal = (market: SavedMarket, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditMarketId(market.id);
    setEditName(market.eventTitle);
    setEditExpiry(market.expiryDate ?? null);
    setEditCategory(market.category || "");
    setEditModalOpen(true);
  };

  const handleEditSave = async () => {
    if (!editMarketId) return;
    await updateMarketMeta(editMarketId, {
      eventTitle: editName,
      expiryDate: editExpiry,
      category: editCategory,
    });
    setEditModalOpen(false);
    setEditMarketId(null);
  };

  // Overview sorted markets
  const sortedOverviewMarkets = (() => {
    let arr = [...savedMarkets];
    // Expiry filter
    if (overviewExpiryFilter !== "all") {
      const thresholdDays = overviewExpiryFilter === "lte30" ? 30 : overviewExpiryFilter === "lte14" ? 14 : 7;
      const now = Date.now();
      arr = arr.filter(m => {
        if (!m.expiryDate) return true;
        const diffMs = new Date(m.expiryDate).getTime() - now;
        const days = diffMs / 86400000;
        return days <= thresholdDays && days >= 0;
      });
    }
    // Sort
    if (overviewSort === "expiry") {
      arr.sort((a, b) => {
        const aExp = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
        const bExp = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
        return overviewSortDir === "asc" ? aExp - bExp : bExp - aExp;
      });
    } else if (overviewSort === "roi") {
      arr.sort((a, b) => {
        const aRoi = a.lastScanResult?.bestRoiPct ?? -1;
        const bRoi = b.lastScanResult?.bestRoiPct ?? -1;
        return overviewSortDir === "desc" ? bRoi - aRoi : aRoi - bRoi;
      });
    } else if (overviewSort === "apy") {
      arr.sort((a, b) => {
        const aApy = (() => {
          if (!a.expiryDate || !a.lastScanResult?.bestRoiPct || a.lastScanResult.bestRoiPct <= 0) return -1;
          const days = (new Date(a.expiryDate).getTime() - Date.now()) / 86400000;
          if (days <= 0) return -1;
          return a.lastScanResult.bestRoiPct * (365 / days);
        })();
        const bApy = (() => {
          if (!b.expiryDate || !b.lastScanResult?.bestRoiPct || b.lastScanResult.bestRoiPct <= 0) return -1;
          const days = (new Date(b.expiryDate).getTime() - Date.now()) / 86400000;
          if (days <= 0) return -1;
          return b.lastScanResult.bestRoiPct * (365 / days);
        })();
        return overviewSortDir === "desc" ? bApy - aApy : aApy - bApy;
      });
    } else {
      arr.sort((a, b) => {
        const cmp = a.eventTitle.localeCompare(b.eventTitle);
        return overviewSortDir === "asc" ? cmp : -cmp;
      });
    }
    return arr;
  })();

  const toggleOverviewSort = (field: OverviewSort) => {
    if (overviewSort === field) setOverviewSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setOverviewSort(field); setOverviewSortDir(field === "roi" || field === "apy" ? "desc" : "asc"); }
  };

  const sortedSidebarMarkets = (() => {
    let arr = [...savedMarkets];
    if (sidebarCategoryFilter) {
      arr = arr.filter(m => m.category === sidebarCategoryFilter);
    }
    if (sidebarSearch.trim()) {
      const q = sidebarSearch.toLowerCase();
      arr = arr.filter(m => m.eventTitle.toLowerCase().includes(q) || (m.category?.toLowerCase().includes(q) ?? false));
    }
    if (sidebarSort === "name") {
      arr.sort((a, b) => {
        const cmp = a.eventTitle.localeCompare(b.eventTitle);
        return sidebarSortDir === "asc" ? cmp : -cmp;
      });
    } else if (sidebarSort === "roi") {
      arr.sort((a, b) => {
        const aRoi = a.lastScanResult?.bestRoiPct ?? -1;
        const bRoi = b.lastScanResult?.bestRoiPct ?? -1;
        return sidebarSortDir === "desc" ? bRoi - aRoi : aRoi - bRoi;
      });
    } else if (sidebarSort === "expiry") {
      arr.sort((a, b) => {
        const aExp = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
        const bExp = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
        return sidebarSortDir === "asc" ? aExp - bExp : bExp - aExp;
      });
    } else if (sidebarSort === "apy") {
      arr.sort((a, b) => {
        const aApy = (() => {
          if (!a.expiryDate || !a.lastScanResult?.bestRoiPct || a.lastScanResult.bestRoiPct <= 0) return -1;
          const days = (new Date(a.expiryDate).getTime() - Date.now()) / 86400000;
          if (days <= 0) return -1;
          return a.lastScanResult.bestRoiPct * (365 / days);
        })();
        const bApy = (() => {
          if (!b.expiryDate || !b.lastScanResult?.bestRoiPct || b.lastScanResult.bestRoiPct <= 0) return -1;
          const days = (new Date(b.expiryDate).getTime() - Date.now()) / 86400000;
          if (days <= 0) return -1;
          return b.lastScanResult.bestRoiPct * (365 / days);
        })();
        return sidebarSortDir === "desc" ? bApy - aApy : aApy - bApy;
      });
    }
    return arr;
  })();

  const toggleSidebarSort = (field: SidebarSort) => {
    if (sidebarSort === field) setSidebarSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSidebarSort(field); setSidebarSortDir(field === "roi" || field === "apy" ? "desc" : "asc"); }
  };

  const timeUntilExpiry = (iso: string | null | undefined) => {
    if (!iso) return null;
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return "Expired";
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours >= 1) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] flex">
      {/* Sidebar */}
      <aside className={`shrink-0 border-r border-[#1a1a1a] bg-[#0f0f0f] flex flex-col sticky top-0 h-screen transition-all duration-300 ${sidebarOpen ? "w-[22.5rem]" : "w-14"}`}>
        <div className="flex items-center justify-between px-3 py-3 border-b border-[#1a1a1a]">
          {sidebarOpen && (
            <div className="flex items-center gap-2">
              <Bookmark className="w-4 h-4 text-[#22c55e]" />
              <span className="text-sm font-semibold">Saved Markets</span>
            </div>
          )}
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1.5 rounded-md hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors">
            {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </div>

        <button onClick={goToOverview} className={`flex items-center gap-2 px-3 py-2.5 mx-2 mt-2 rounded-lg text-sm transition-colors ${viewMode === "overview" ? "bg-[#22c55e]/10 text-[#22c55e]" : "bg-[#1a1a1a] text-[#a3a3a3] hover:bg-[#262626] hover:text-[#e5e5e5]"}`}>
          <BarChart3 className="w-4 h-4 shrink-0" />
          {sidebarOpen && <span>Overview</span>}
        </button>

        <button onClick={goToMarketFinder} className={`flex items-center gap-2 px-3 py-2.5 mx-2 mt-1 rounded-lg text-sm transition-colors ${viewMode === "marketfinder" ? "bg-[#22c55e]/10 text-[#22c55e]" : "bg-[#1a1a1a] text-[#a3a3a3] hover:bg-[#262626] hover:text-[#e5e5e5]"}`}>
          <Globe className="w-4 h-4 shrink-0" />
          {sidebarOpen && <span>MarketFinder</span>}
        </button>

        {sidebarOpen && (
          <div className="mx-2 mt-2 relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#737373] pointer-events-none" />
            <input
              type="text"
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              placeholder="Search markets..."
              className="w-full bg-[#1a1a1a] border border-[#262626] rounded-lg pl-8 pr-2 py-1.5 text-xs text-[#e5e5e5] placeholder:text-[#525252] focus:outline-none focus:border-[#22c55e]/50"
            />
            {sidebarSearch && (
              <button
                onClick={() => setSidebarSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#525252] hover:text-[#e5e5e5]"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-2 space-y-1 px-2">
          {sidebarOpen && allCategories.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 mb-2">
              <button
                onClick={() => setSidebarCategoryFilter("")}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                  !sidebarCategoryFilter ? "bg-[#22c55e]/20 text-[#22c55e]" : "bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5]"
                }`}
              >
                All
              </button>
              {allCategories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setSidebarCategoryFilter(cat)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                    sidebarCategoryFilter === cat ? "bg-[#22c55e]/20 text-[#22c55e]" : "bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5]"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
          {sidebarOpen && savedMarkets.length > 0 && (
            <div className="flex items-center gap-1 px-2 mb-2">
              <span className="text-[10px] text-[#737373] uppercase tracking-wider font-medium">Sort by</span>
              <div className="flex gap-0.5 ml-auto">
                {(["name","roi","expiry","apy"] as SidebarSort[]).map((field) => (
                  <button
                    key={field}
                    onClick={() => toggleSidebarSort(field)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                      sidebarSort === field
                        ? "bg-[#22c55e]/20 text-[#22c55e]"
                        : "text-[#525252] hover:text-[#a3a3a3]"
                    }`}
                    title={`Sort by ${field}${sidebarSort === field ? (sidebarSortDir === "asc" ? " ↑" : " ↓") : ""}`}
                  >
                    {field === "name" ? "Name" : field === "roi" ? "ROI" : field === "expiry" ? "Expiry" : "APY"}
                    {sidebarSort === field && (sidebarSortDir === "asc" ? " ↑" : " ↓")}
                  </button>
                ))}
              </div>
            </div>
          )}
          {sortedSidebarMarkets.map((market) => {
            const last = market.lastScanResult;
            const hasPositive = last && last.bestRoiPct > 0;
            return (
              <div key={market.id} onClick={() => loadMarket(market)} className={`group relative flex items-center gap-2 px-2 pr-1 py-2 rounded-lg cursor-pointer transition-colors text-sm ${activeMarketId === market.id && viewMode === "scan" ? "bg-[#22c55e]/10 text-[#22c55e]" : "text-[#a3a3a3] hover:bg-[#1a1a1a] hover:text-[#e5e5e5]"}`} title={market.eventTitle}>
                <Bookmark className="w-3.5 h-3.5 shrink-0" />
                {sidebarOpen && (
                  <>
                    <div className="flex-1 min-w-0 flex items-center gap-1">
                      <span className="truncate">{market.eventTitle}</span>
                      {market.category && (
                        <span className="text-[9px] font-medium px-1 py-0.5 rounded-full bg-[#1a1a1a] text-[#737373] shrink-0">{market.category}</span>
                      )}
                    </div>
                    <div className="ml-auto shrink-0 flex items-center gap-0.5">
                      {last && (
                        <>
                          <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${hasPositive ? "bg-[#22c55e]/20 text-[#22c55e]" : "bg-[#262626] text-[#737373]"}`}>
                            {hasPositive ? `+${last.bestRoiPct.toFixed(2)}%` : "0%"}
                          </span>
                          {(() => {
                            if (!market.expiryDate || !hasPositive) return null;
                            const days = (new Date(market.expiryDate).getTime() - Date.now()) / 86400000;
                            if (days <= 0) return null;
                            const apy = last.bestRoiPct * (365 / days);
                            return <span className="text-[9px] text-[#737373]">({apy.toFixed(0)}% APY)</span>;
                          })()}
                        </>
                      )}
                    </div>
                    <div className="shrink-0 hidden group-hover:flex items-center gap-0">
                      <button onClick={(e) => openEditModal(market, e)} className="p-1 rounded hover:bg-[#262626] text-[#737373] hover:text-[#e5e5e5] transition-colors">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); deleteMarket(market.id); }} className="p-1 rounded hover:bg-[#ef4444]/20 text-[#737373] hover:text-[#ef4444] transition-colors">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
          {savedMarkets.length === 0 && sidebarOpen && (
            <div className="px-2 py-4 text-xs text-[#525252] text-center">No saved markets yet.<br />Scan and save one!</div>
          )}
        </div>

        <button onClick={goToNewScan} className="flex items-center gap-2 px-3 py-2.5 mx-2 my-2 rounded-lg bg-[#22c55e]/10 text-[#22c55e] hover:bg-[#22c55e]/20 transition-colors text-sm font-medium border border-[#22c55e]/20 shrink-0">
          <Plus className="w-4 h-4 shrink-0" />
          {sidebarOpen && <span>Add market</span>}
        </button>
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <header className="border-b border-[#1a1a1a] bg-[#0f0f0f]">
          <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#22c55e]/10 flex items-center justify-center">
                <Zap className="w-5 h-5 text-[#22c55e]" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">H2H Arbitrage</h1>
                <p className="text-xs text-[#737373]">Kalshi × Polymarket · Head-to-Head Scanner</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {isPolling && (
                <>
                  <span className="flex items-center gap-1.5 text-xs text-[#22c55e]">
                    <span className="w-2 h-2 rounded-full bg-[#22c55e] animate-pulse" /> Live
                  </span>
                  <span className="text-xs text-[#737373]">
                    {lastUpdated ? `Updated ${Math.max(0, Math.floor((pollTimer - lastUpdated.getTime()) / 1000))}s ago` : ""}
                  </span>
                  <span className="text-xs text-[#525252]">
                    {lastScanTime ? `(${new Date(lastScanTime).toISOString().split("T")[1].split(".")[0]})` : ""}
                  </span>
                </>
              )}
              {isPolling && (
                <button onClick={stopPolling} className="px-3 py-1.5 text-xs rounded-md bg-[#1a1a1a] hover:bg-[#262626] text-[#e5e5e5] transition-colors">Stop</button>
              )}
            </div>
          </div>
        </header>

        <main className="max-w-7xl mx-auto px-4 py-6">
          {viewMode === "overview" ? (
            <OverviewPanel
              markets={sortedOverviewMarkets}
              onSelectMarket={loadMarket}
              onEditMarket={openEditModal}
              onDeleteMarket={deleteMarket}
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
              onFetch={() => {
                setMfLoading(true);
                fetch("/api/predictionhunt/markets", { headers: { "Cache-Control": "no-store" } })
                  .then((r) => r.json())
                  .then((d) => {
                    if (d.success) {
                      setMfMarkets(d.markets || []);
                      setMfLastSync(d.lastSync);
                    }
                    setMfError("");
                  })
                  .catch(() => setMfError("Failed to load MarketFinder data"))
                  .finally(() => setMfLoading(false));
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
                            setMfMarkets(d2.markets || []);
                            setMfLastSync(d2.lastSync);
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
                      // Refresh saved markets
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
            />
          ) : (
            <>
              {/* Scan inputs — hidden when viewing a saved market */}
              {!activeMarketId && (
              <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] p-5 mb-6">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm font-medium text-[#a3a3a3]">
                      <Link2 className="w-4 h-4" /> Kalshi URL
                    </label>
                    <input type="text" value={kalshiUrl} onChange={(e) => setKalshiUrl(e.target.value)} className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] placeholder-[#525252] focus:outline-none focus:border-[#22c55e] focus:ring-1 focus:ring-[#22c55e]/30 transition-all" placeholder="https://kalshi.com/markets/..." />
                  </div>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm font-medium text-[#a3a3a3]">
                      <Link2 className="w-4 h-4" /> Polymarket URL
                    </label>
                    <input type="text" value={pmUrl} onChange={(e) => setPmUrl(e.target.value)} className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] placeholder-[#525252] focus:outline-none focus:border-[#22c55e] focus:ring-1 focus:ring-[#22c55e]/30 transition-all" placeholder="https://polymarket.com/event/..." />
                  </div>
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <button onClick={() => handleScan(false)} disabled={loading} className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#22c55e] text-black font-semibold text-sm hover:bg-[#16a34a] transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scan className="w-4 h-4" />}
                    {loading ? "Scanning..." : "Scan Markets"}
                  </button>

                  {result && (
                    <button onClick={openSaveModal} disabled={saving} className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-[#e5e5e5] text-sm hover:bg-[#262626] transition-all disabled:opacity-50">
                      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                      {saving ? "Saving..." : "Save Market"}
                    </button>
                  )}

                  <div className="flex items-center gap-2 ml-auto">
                    <label className="text-xs text-[#737373]">Capital:</label>
                    <input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))} className="w-24 px-2 py-1.5 rounded-md bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] focus:outline-none focus:border-[#22c55e]" />
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
                      <h2 className="text-xl font-bold tracking-tight text-[#e5e5e5]">{result.eventTitle}</h2>
                      {savedMarkets.find(m => m.id === activeMarketId)?.category && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#1a1a1a] text-[#737373]">
                          {savedMarkets.find(m => m.id === activeMarketId)?.category}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <StatCard label="Kalshi Markets" value={result.kalshiCount} icon={<Activity className="w-4 h-4" />} color="blue" />
                    <StatCard label="Polymarket Markets" value={result.pmCount} icon={<Activity className="w-4 h-4" />} color="purple" />
                    <StatCard label="Matched Pairs" value={result.matchedCount} icon={<Link2 className="w-4 h-4" />} color="green" />
                    <StatCard label="Expiry" value={formatExpiry(result.expiryDate)} icon={<Calendar className="w-4 h-4" />} color="yellow" valueSize="xs" />
                    <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] p-1 flex gap-1">
                      <a href={kalshiUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 flex-1 flex items-center justify-center rounded-lg bg-[#22c55e]/10 text-[#22c55e] hover:bg-[#22c55e]/20 transition-colors text-xs font-bold py-3" title="Kalshi">
                        <img src="/kalshi-icon.png" alt="Kalshi" className="w-8 h-8 rounded-sm" />
                      </a>
                      <a href={pmUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 flex-1 flex items-center justify-center rounded-lg bg-[#a855f7]/10 text-[#a855f7] hover:bg-[#a855f7]/20 transition-colors text-xs font-bold py-3" title="Polymarket">
                        <img src="/polymarket-icon.png" alt="Polymarket" className="w-8 h-8 rounded-sm" />
                      </a>
                      {activeMarketId ? (
                        <button
                          onClick={() => {
                            const market = savedMarkets.find(m => m.id === activeMarketId);
                            if (market) handleScanWithUrls(market.kalshiUrl, market.polymarketUrl);
                          }}
                          disabled={loading}
                          className="flex-1 flex items-center justify-center rounded-lg bg-[#262626] text-[#737373] hover:text-[#e5e5e5] hover:bg-[#404040] transition-colors disabled:opacity-50 py-3"
                          title="Refresh"
                        >
                          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                        </button>
                      ) : (
                        <div className="flex-1" />
                      )}
                    </div>
                  </div>

                  {(result.kalshiCount === 0 || result.pmCount === 0 || result.matchedCount === 0) && (
                    <div className="rounded-xl border border-[#eab308]/30 bg-[#eab308]/10 p-3 flex items-start gap-3 text-sm text-[#facc15]">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <div className="space-y-1">
                        <div className="font-semibold">Market data warning</div>
                        <div className="text-xs text-[#d4d4d4]">
                          {result.kalshiCount === 0 && <span className="mr-3">Kalshi returned 0 open markets.</span>}
                          {result.pmCount === 0 && <span className="mr-3">Polymarket returned 0 markets.</span>}
                          {result.kalshiCount > 0 && result.pmCount > 0 && result.matchedCount === 0 && <span className="mr-3">No matched pairs found. Manual matching may be needed.</span>}
                        </div>
                        <div className="text-[11px] text-[#a3a3a3]">
                          Raw: K {result.kalshiRawCount ?? result.kalshiCount} / PM {result.pmRawCount ?? result.pmCount}; PM filtered {result.pmFilteredCount ?? result.pmCount}; Kalshi source {result.kalshiFetchSource ?? "unknown"}; CLOB {result.clobHitCount ?? 0} hit / {result.clobMissCount ?? 0} miss
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] overflow-hidden">
                    <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center justify-between">
                      <h2 className="text-sm font-semibold">All Outcomes · {result.outcomes.filter(o => !!o.kalshi && !!o.polymarket).length} matched</h2>
                      <button onClick={() => setHideUnmatched(v => !v)} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors border ${hideUnmatched ? "bg-[#22c55e]/10 border-[#22c55e]/30 text-[#22c55e]" : "bg-[#1a1a1a] border-[#262626] text-[#737373] hover:text-[#e5e5e5]"}`}>
                        <Filter className="w-3 h-3" /> {hideUnmatched ? "Showing matched only" : "Show all"}
                      </button>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-[#1a1a1a] text-xs text-[#737373]">
                            <th className="px-4 py-2 text-left font-medium">Artist / Outcome</th>
                            <th className="px-4 py-2 text-center font-medium">Kalshi YES</th>
                            <th className="px-4 py-2 text-center font-medium">Kalshi NO</th>
                            <th className="px-4 py-2 text-center font-medium">PM YES</th>
                            <th className="px-4 py-2 text-center font-medium">PM NO</th>
                            <th className="px-4 py-2 text-center font-medium cursor-pointer hover:text-[#e5e5e5] select-none" onClick={() => { if (sortField === "roi") setSortDirection((p) => (p === "desc" ? "asc" : "desc")); else { setSortField("roi"); setSortDirection("desc"); } }}>
                              <div className="flex items-center justify-center gap-1">
                                Arbitrage
                                {sortField === "roi" && (<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={sortDirection === "asc" ? "rotate-180" : ""}><polyline points="6 9 12 15 18 9" /></svg>)}
                              </div>
                            </th>
                            <th className="px-4 py-2 text-right font-medium"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1a1a1a]">
                          {sortedData.map((outcome, idx) => {
                            const isMatched = !!outcome.kalshi && !!outcome.polymarket;
                            const isExpanded = expandedArtist === outcome.artist;
                            const arb = outcome.arbitrage;
                            const hasArb = arb.roiPct > 0;
                            const priceFlash = priceChanges.get(outcome.artist);
                            return (
                              <>
                              <tr key={`${outcome.artist}-${idx}`} className={`transition-colors ${isMatched ? "bg-[#22c55e]/[0.02]" : ""} hover:bg-[#1a1a1a]/50 ${priceFlash === "up" ? "bg-[#22c55e]/[0.15]" : priceFlash === "down" ? "bg-[#ef4444]/[0.15]" : ""} ${priceFlash ? "animate-pulse" : ""}`}>
                                <td className="px-4 py-3"><div className="flex items-center gap-2"><span className={`text-sm font-medium ${isMatched ? "text-[#22c55e]" : "text-[#a3a3a3]"}`}>{outcome.artist}</span></div></td>
                                <td className="px-4 py-3 text-center">{outcome.kalshi ? (<div><div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.kalshi.yesAsk)}</div>{outcome.kalshi.yesAskDepth && (<div className="text-[10px] text-[#737373]">({outcome.kalshi.yesAskDepth})</div>)}</div>) : (<span className="text-[#404040]">—</span>)}</td>
                                <td className="px-4 py-3 text-center">{outcome.kalshi ? (<div><div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.kalshi.noAsk)}</div>{outcome.kalshi.noAskDepth && (<div className="text-[10px] text-[#737373]">({outcome.kalshi.noAskDepth})</div>)}</div>) : (<span className="text-[#404040]">—</span>)}</td>
                                <td className="px-4 py-3 text-center">{outcome.polymarket ? (<div><div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.polymarket.yesPrice)}</div>{(outcome.polymarket.askDepth ?? 0) > 0 && (<div className="text-[10px] text-[#737373]">(${Math.round(outcome.polymarket.askDepth!)})</div>)}</div>) : (<span className="text-[#404040]">—</span>)}</td>
                                <td className="px-4 py-3 text-center">{outcome.polymarket ? (<div><div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.polymarket.noPrice)}</div>{((outcome.polymarket.noAskDepth ?? outcome.polymarket.askDepth) ?? 0) > 0 && (<div className="text-[10px] text-[#737373]">(${Math.round((outcome.polymarket.noAskDepth ?? outcome.polymarket.askDepth)!)})</div>)}</div>) : (<span className="text-[#404040]">—</span>)}</td>
                                <td className="px-4 py-3 text-center">{isMatched ? (<div className="flex flex-col items-center"><span className={`text-xs font-bold ${hasArb ? "text-[#22c55e]" : "text-[#737373]"}`}>{hasArb ? `+${arb.roiPct.toFixed(2)}%` : "No arb"}</span>{hasArb && <span className="text-[10px] text-[#737373]">{formatDollar(arb.expectedProfit)} profit</span>}</div>) : (<span className="text-[#404040]">—</span>)}</td>
                                <td className="px-4 py-3 text-right"><div className="flex items-center justify-end gap-1">{outcome.kalshi && (<a href={kalshiUrl} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"><ExternalLink className="w-3.5 h-3.5" /></a>)}{outcome.polymarket && (<a href={pmUrl} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"><ExternalLink className="w-3.5 h-3.5" /></a>)}{isMatched && (<button onClick={() => setExpandedArtist(isExpanded ? null : outcome.artist)} className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"><TrendingUp className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`} /></button>)}</div></td>
                              </tr>
                              {isExpanded && isMatched && (
                                <tr>
                                  <td colSpan={7} className="px-4 py-4 bg-[#0f0f0f] border-t border-[#1a1a1a]">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                                      <div className="space-y-2">
                                        <div className="text-[#737373] font-semibold uppercase tracking-wider">Arb Details</div>
                                        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                          <span className="text-[#525252]">Strategy:</span>
                                          <span className="text-[#e5e5e5]">{arb.strategy}</span>
                                          <span className="text-[#525252]">Buy platform:</span>
                                          <span className={`${arb.buyPlatform === 'kalshi' ? 'text-[#3b82f6]' : 'text-[#a855f7]'}`}>{arb.buyPlatform?.toUpperCase() || '—'}</span>
                                          <span className="text-[#525252]">Buy price:</span>
                                          <span className="text-[#e5e5e5]">{formatPrice(arb.buyPrice)}</span>
                                          <span className="text-[#525252]">Sell platform:</span>
                                          <span className={`${arb.sellPlatform === 'kalshi' ? 'text-[#3b82f6]' : 'text-[#a855f7]'}`}>{arb.sellPlatform?.toUpperCase() || '—'}</span>
                                          <span className="text-[#525252]">Sell price:</span>
                                          <span className="text-[#e5e5e5]">{formatPrice(arb.sellPrice)}</span>
                                        </div>
                                      </div>
                                      <div className="space-y-2">
                                        <div className="text-[#737373] font-semibold uppercase tracking-wider">Stake &amp; Profit</div>
                                        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                          <span className="text-[#525252]">Kalshi stake:</span>
                                          <span className="text-[#e5e5e5]">{formatDollar(arb.kalshiStake)}</span>
                                          <span className="text-[#525252]">PM stake:</span>
                                          <span className="text-[#e5e5e5]">{formatDollar(arb.pmStake)}</span>
                                          <span className="text-[#525252]">Expected profit:</span>
                                          <span className="text-[#22c55e] font-bold">{formatDollar(arb.expectedProfit)}</span>
                                          <span className="text-[#525252]">ROI:</span>
                                          <span className={`font-bold ${arb.roiPct > 0 ? 'text-[#22c55e]' : 'text-[#737373]'}`}>{hasArb ? `+${arb.roiPct.toFixed(2)}%` : '0%'}</span>
                                          {arb.apyPct != null && arb.apyPct > 0 && (
                                            <>
                                              <span className="text-[#525252]">APY est:</span>
                                              <span className="text-[#eab308] font-bold">{arb.apyPct.toFixed(1)}%</span>
                                            </>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                              </>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>


      {/* Manual Matching Panel */}
      {result && (result.unmatchedKalshi?.length > 0 || result.unmatchedPolymarket?.length > 0) && (
        <ManualMatchingPanel
          open={rightPanelOpen}
          onToggle={() => setRightPanelOpen(!rightPanelOpen)}
          kalshiUrl={kalshiUrl}
          pmUrl={pmUrl}
          pmSlug={result.pmEventSlug}
          unmatchedKalshi={result.unmatchedKalshi || []}
          unmatchedPolymarket={result.unmatchedPolymarket || []}
          manualMatches={manualMatches}
          selectedKalshi={selectedKalshi}
          selectedPM={selectedPM}
          onSelectKalshi={setSelectedKalshi}
          onSelectPM={setSelectedPM}
          onCreateMatch={createManualMatch}
          onDeleteMatch={deleteManualMatch}
          msg={manualMatchMsg}
        />
      )}

      {/* Save Modal */}
      {saveModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setSaveModalOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-[#262626] bg-[#111111] p-6 space-y-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Save Market</h2>
              <button onClick={() => setSaveModalOpen(false)} className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5]"><X className="w-5 h-5" /></button>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-[#a3a3a3]">Market Name</label>
              <input type="text" value={saveName} onChange={(e) => setSaveName(e.target.value)} className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] placeholder-[#525252] focus:outline-none focus:border-[#22c55e] focus:ring-1 focus:ring-[#22c55e]/30 transition-all" placeholder="Enter market name…" />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-[#a3a3a3]">Category</label>
              <select value={saveCategory} onChange={(e) => setSaveCategory(e.target.value)} className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] focus:outline-none focus:border-[#22c55e] focus:ring-1 focus:ring-[#22c55e]/30 transition-all">
                <option value="">No category</option>
                <option value="Politics">Politics</option>
                <option value="Temperature">Temperature</option>
                <option value="Finances">Finances</option>
                <option value="Mentions">Mentions</option>
                <option value="Sports">Sports</option>
              </select>
            </div>

            {result?.expiryDate && (
              <div className="text-xs text-[#737373] flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Expiry: {formatExpiry(result.expiryDate)}
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <button onClick={() => setSaveModalOpen(false)} className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-[#737373] hover:text-[#e5e5e5] hover:bg-[#1a1a1a] transition-colors">Cancel</button>
              <button onClick={saveCurrentMarket} disabled={saving} className="flex-1 px-4 py-2.5 rounded-lg bg-[#22c55e] text-black text-sm font-semibold hover:bg-[#16a34a] transition-colors disabled:opacity-50">
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setEditModalOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-[#262626] bg-[#111111] p-6 space-y-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Edit Market</h2>
              <button onClick={() => setEditModalOpen(false)} className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5]"><X className="w-5 h-5" /></button>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-[#a3a3a3]">Market Name</label>
              <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] focus:outline-none focus:border-[#22c55e] focus:ring-1 focus:ring-[#22c55e]/30 transition-all" />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-[#a3a3a3]">Category</label>
              <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)} className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] focus:outline-none focus:border-[#22c55e] focus:ring-1 focus:ring-[#22c55e]/30 transition-all">
                <option value="">No category</option>
                <option value="Politics">Politics</option>
                <option value="Temperature">Temperature</option>
                <option value="Finances">Finances</option>
                <option value="Mentions">Mentions</option>
                <option value="Sports">Sports</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-[#a3a3a3]">Expiry Date</label>
              <DateTimePicker value={editExpiry} onChange={setEditExpiry} placeholder="No expiry set" />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button onClick={() => setEditModalOpen(false)} className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-[#737373] hover:text-[#e5e5e5] hover:bg-[#1a1a1a] transition-colors">Cancel</button>
              <button onClick={handleEditSave} className="flex-1 px-4 py-2.5 rounded-lg bg-[#22c55e] text-black text-sm font-semibold hover:bg-[#16a34a] transition-colors">Update</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Overview Panel: Flashcard Dashboard ── */
function OverviewPanel({
  markets,
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
}: {
  markets: SavedMarket[];
  onSelectMarket: (m: SavedMarket) => void;
  onEditMarket: (m: SavedMarket, e: React.MouseEvent) => void;
  onDeleteMarket: (id: string) => void;
  sort: OverviewSort;
  sortDir: "asc" | "desc";
  onToggleSort: (field: OverviewSort) => void;
  timeUntilExpiry: (iso: string | null | undefined) => string | null;
  layout: "grid" | "table";
  onToggleLayout: (l: "grid" | "table") => void;
  expiryFilter: "all" | "lte7" | "lte14" | "lte30";
  onSetExpiryFilter: (f: "all" | "lte7" | "lte14" | "lte30") => void;
  onScanAll?: () => void;
  scanningAll?: boolean;
  scanAllError?: string;
}) {
  return (
    <div className="space-y-5">
      {/* Top summary cards */}
      {(() => {
        const withResults = markets.filter(m => m.lastScanResult && m.lastScanResult.bestRoiPct > 0);

        // Total Profit: sum ALL positive arbs per market
        const totalProfit = withResults.reduce((sum, m) => {
          const arbs = m.lastScanResult?.allArbs;
          if (arbs && arbs.length > 0) return sum + arbs.reduce((s, a) => s + a.expectedProfit, 0);
          return sum + (m.lastScanResult?.bestProfit ?? 0);
        }, 0);

        // Weighted APY: vikta ALLA individuella arbs över hela portfolion
        const activeForApy = withResults.filter(m => {
          if (!m.expiryDate) return false;
          const days = (new Date(m.expiryDate).getTime() - Date.now()) / 86400000;
          return days > 0;
        });
        const totalStakeForApy = activeForApy.reduce((sum, m) => {
          const r = m.lastScanResult!;
          const arbs = r.allArbs;
          if (arbs && arbs.length > 0) {
            return sum + arbs.reduce((s, a) => s + (a.expectedProfit / (a.roiPct / 100)), 0);
          }
          return sum + (r.bestProfit / (r.bestRoiPct / 100));
        }, 0);
        const weightedApy = totalStakeForApy > 0
          ? activeForApy.reduce((sum, m) => {
              const r = m.lastScanResult!;
              const days = (new Date(m.expiryDate!).getTime() - Date.now()) / 86400000;
              const arbs = r.allArbs;
              if (arbs && arbs.length > 0) {
                return sum + arbs.reduce((s, a) => {
                  const stake = a.expectedProfit / (a.roiPct / 100);
                  const apy = a.roiPct * (365 / days);
                  return s + apy * stake;
                }, 0);
              }
              const stake = r.bestProfit / (r.bestRoiPct / 100);
              const apy = r.bestRoiPct * (365 / days);
              return sum + apy * stake;
            }, 0) / totalStakeForApy
          : 0;

        // Total Stake: sum ALL individual stakes across all arbs
        const totalStake = withResults.reduce((sum, m) => {
          const r = m.lastScanResult;
          if (!r || r.bestRoiPct <= 0) return sum;
          const arbs = r.allArbs;
          if (arbs && arbs.length > 0) {
            return sum + arbs.reduce((s, a) => s + (a.expectedProfit / (a.roiPct / 100)), 0);
          }
          return sum + (r.bestProfit / (r.bestRoiPct / 100));
        }, 0);
        return (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="group relative rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] p-4">
              <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Total Profit Potential</div>
              <div className="text-2xl font-bold text-[#22c55e]">{formatProfit(totalProfit)}</div>
              <div className="text-xs text-[#525252] mt-0.5">Across {withResults.length} markets</div>
              {withResults.length > 0 && (
                <div className="absolute z-10 top-full mt-2 left-0 right-0 rounded-lg border border-[#262626] bg-[#111111] p-3 shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                  <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-2">Breakdown</div>
                  <div className="space-y-1">
                    {withResults.map(m => (
                      <div key={m.id} className="flex items-center justify-between text-xs">
                        <span className="text-[#a3a3a3] truncate max-w-[60%]">{m.eventTitle}</span>
                        <span className="text-[#22c55e] font-mono">{formatProfit(m.lastScanResult?.bestProfit ?? 0)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] p-4">
              <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Total Stake Required</div>
              <div className="text-2xl font-bold text-[#e5e5e5]">{formatProfit(totalStake)}</div>
              <div className="text-xs text-[#525252] mt-0.5">At best available depth</div>
            </div>
            <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] p-4">
              <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Weighted APY</div>
              <div className="text-2xl font-bold text-[#22c55e]">{weightedApy.toFixed(2)}%</div>
              <div className="text-xs text-[#525252] mt-0.5">Profit-weighted average</div>
            </div>
          </div>
        );
      })()}

      {/* Header + sort controls + layout toggle + Scan All */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-semibold">Market Overview</h2>
        <div className="flex items-center gap-2">
          {(["expiry", "roi", "apy", "name"] as OverviewSort[]).map((field) => (
            <button
              key={field}
              onClick={() => onToggleSort(field)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sort === field
                  ? "bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/30"
                  : "bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] border border-transparent"
              }`}
            >
              {field === "expiry" ? "Expiry" : field === "roi" ? "Best Arb" : field === "apy" ? "APY%" : "Name"}
              {sort === field && (
                sortDir === "asc"
                  ? <ArrowUp className="w-3 h-3" />
                  : <ArrowDown className="w-3 h-3" />
              )}
            </button>
          ))}
          <div className="w-px h-5 bg-[#262626] mx-0.5" />
          <button
            onClick={() => onToggleLayout(layout === "grid" ? "table" : "grid")}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] border border-transparent hover:border-[#262626]"
            title={layout === "grid" ? "Switch to table view" : "Switch to grid view"}
          >
            {layout === "grid" ? <><Rows3 className="w-3 h-3" /> List</> : <><LayoutGrid className="w-3 h-3" /> Grid</>}
          </button>
          {onScanAll && (
            <button
              onClick={onScanAll}
              disabled={scanningAll}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/30 hover:bg-[#22c55e]/20 disabled:opacity-50"
              title="Refresh all saved markets now"
            >
              {scanningAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {scanningAll ? "Scanning…" : "Scan All"}
            </button>
          )}
        </div>
      </div>

      {scanAllError && (
        <div className="text-xs text-[#ef4444] flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {scanAllError}
        </div>
      )}

      {/* Expiry filter toolbar */}
      <div className="flex items-center gap-2">
        {(["all", "lte7", "lte14", "lte30"] as const).map((f) => (
          <button
            key={f}
            onClick={() => onSetExpiryFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              expiryFilter === f
                ? "bg-[#22c55e]/10 text-[#22c55e] border-[#22c55e]/30"
                : "bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] border-transparent"
            }`}
          >
            {f === "all" ? "All" : f === "lte7" ? "7d" : f === "lte14" ? "14d" : "30d"}
          </button>
        ))}
        <span className="text-[#525252] text-xs ml-2">
          {markets.length} market{markets.length !== 1 ? "s" : ""} shown
        </span>
      </div>

      {/* Flashcard grid or Table */}
      {layout === "grid" ? (
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3 gap-4">
        {markets.map((market) => {
          const last = market.lastScanResult;
          const hasArb = last && last.bestRoiPct > 0;
          const ttl = timeUntilExpiry(market.expiryDate);
          const isExpired = ttl === "Expired";
          const scannedAgo = last ? getTimeAgo(last.scannedAt) : null;
          const apy = (() => {
            if (!market.expiryDate || !last?.bestRoiPct || last.bestRoiPct <= 0) return null;
            const days = (new Date(market.expiryDate).getTime() - Date.now()) / 86400000;
            if (days <= 0) return null;
            return last.bestRoiPct * (365 / days);
          })();

          return (
            <div
              key={market.id}
              onClick={() => onSelectMarket(market)}
              className={`group relative p-5 rounded-xl border bg-[#0f0f0f] cursor-pointer transition-all hover:scale-[1.01] ${
                hasArb
                  ? "border-[#22c55e]/30 hover:border-[#22c55e]/60 hover:shadow-[0_0_20px_rgba(34,197,94,0.1)]"
                  : "border-[#1a1a1a] hover:border-[#262626]"
              }`}
            >
              {/* Top row: name + edit/delete + links */}
              <div className="flex items-start justify-between mb-3">
                <h3 className="text-sm font-semibold text-[#e5e5e5] leading-tight pr-2">{market.eventTitle}</h3>
                <div className="flex items-center gap-1 transition-opacity shrink-0">
                  <a href={market.kalshiUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 p-1 rounded hover:bg-[#22c55e]/20 opacity-70 hover:opacity-100 transition-opacity" title="Kalshi">
                    <img src="/kalshi-icon.png" alt="Kalshi" className="w-4 h-4 rounded-sm" />
                  </a>
                  <a href={market.polymarketUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 p-1 rounded hover:bg-[#a855f7]/20 opacity-70 hover:opacity-100 transition-opacity" title="Polymarket">
                    <img src="/polymarket-icon.png" alt="Polymarket" className="w-4 h-4 rounded-sm" />
                  </a>
                  <button onClick={(e) => onEditMarket(market, e)} className="shrink-0 p-1 rounded hover:bg-[#262626] text-[#737373] hover:text-[#e5e5e5]"><Pencil className="w-3 h-3" /></button>
                  <button onClick={(e) => { e.stopPropagation(); onDeleteMarket(market.id); }} className="shrink-0 p-1 rounded hover:bg-[#ef4444]/20 text-[#737373] hover:text-[#ef4444]"><Trash2 className="w-3 h-3" /></button>
                </div>
              </div>

              {/* Arb flash — the main number */}
              {last ? (
                <div className="mb-3">
                  <div className={`text-3xl font-bold tracking-tight ${hasArb ? "text-[#22c55e]" : "text-[#525252]"}`}>
                    {hasArb ? `+${last.bestRoiPct.toFixed(2)}%` : "0%"}
                  </div>
                  <div className="text-xs text-[#737373] mt-0.5">
                    {last.strategy} · {formatProfit(last.bestProfit)} profit {last.totalStake ? `(${formatDollar(last.totalStake)} total stake)` : ''}
                  </div>
                </div>
              ) : (
                <div className="mb-3">
                  <div className="text-2xl font-bold text-[#525252]">—</div>
                  <div className="text-xs text-[#525252] mt-0.5">Not scanned yet</div>
                </div>
              )}

              {/* Stats row */}
              {last && (
                <div className="flex items-center gap-3 text-[11px] text-[#737373] mb-3">
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6]" /> K: {last.kalshiCount}</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#a855f7]" /> PM: {last.pmCount}</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#22c55e]" /> Match: {last.matchedCount}</span>
                </div>
              )}

              {/* Bottom row: expiry + scan time */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between text-[10px] text-[#525252] pt-2 border-t border-[#1a1a1a] gap-1">
                <div className="flex items-center gap-1 flex-wrap">
                  <Calendar className="w-3 h-3 shrink-0" />
                  {market.expiryDate ? (
                    <span className={`flex items-center gap-1 flex-wrap ${isExpired ? "text-[#ef4444]" : "text-[#737373]"}`}>
                      <span className="whitespace-nowrap">{ttl}</span>
                      <span className="text-[#525252]">·</span>
                      <span className="whitespace-nowrap">{new Date(market.expiryDate).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      {apy !== null && (
                        <>
                          <span className="text-[#525252]">·</span>
                          <span className="text-[#eab308] whitespace-nowrap">{apy.toFixed(0)}% APY</span>
                        </>
                      )}
                    </span>
                  ) : (
                    <span>No expiry</span>
                  )}
                </div>
                {scannedAgo && (
                  <span className="text-[#525252] shrink-0">Scanned {scannedAgo}</span>
                )}
              </div>
            </div>
          );
        })}

        {markets.length === 0 && (
          <div className="col-span-full p-8 rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] text-center text-sm text-[#737373]">
            No saved markets yet. Use &ldquo;Scan Markets&rdquo; to scan a Kalshi + Polymarket pair, then click &ldquo;Save Market&rdquo;.
          </div>
        )}
      </div>
      ) : (
      <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#1a1a1a] text-xs text-[#737373]">
              <th className="px-4 py-2 text-left font-medium">Name</th>
              <th className="px-4 py-2 text-center font-medium">ROI</th>
              <th className="px-4 py-2 text-center font-medium">Profit</th>
              <th className="px-4 py-2 text-center font-medium">APY</th>
              <th className="px-4 py-2 text-center font-medium">Expiry</th>
              <th className="px-4 py-2 text-center font-medium w-28">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1a1a1a]">
            {markets.map((market) => {
              const last = market.lastScanResult;
              const hasArb = last && last.bestRoiPct > 0;
              const ttl = timeUntilExpiry(market.expiryDate);
              const apy = (() => {
                if (!market.expiryDate || !last?.bestRoiPct || last.bestRoiPct <= 0) return null;
                const days = (new Date(market.expiryDate).getTime() - Date.now()) / 86400000;
                if (days <= 0) return null;
                return last.bestRoiPct * (365 / days);
              })();
              return (
                <tr
                  key={market.id}
                  onClick={() => onSelectMarket(market)}
                  className={`cursor-pointer transition-colors hover:bg-[#1a1a1a]/50 ${hasArb ? "bg-[#22c55e]/[0.02]" : ""}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col">
                      <span className="font-medium text-[#e5e5e5] truncate max-w-[200px]">{market.eventTitle}</span>
                      {market.category && <span className="text-[10px] text-[#737373]">{market.category}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs font-bold ${hasArb ? "text-[#22c55e]" : "text-[#525252]"}`}>
                      {hasArb ? `+${last.bestRoiPct.toFixed(2)}%` : "0%"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="text-xs text-[#737373]">
                      {last ? formatProfit(last.bestProfit) : "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="text-xs font-bold text-[#eab308]">
                      {apy !== null ? `${apy.toFixed(0)}%` : "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs ${ttl === "Expired" ? "text-[#ef4444]" : "text-[#737373]"}`}>
                      {ttl ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center gap-1.5">
                      <a href={market.kalshiUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 p-1 rounded hover:bg-[#22c55e]/20 opacity-70 hover:opacity-100 transition-opacity" title="Kalshi">
                        <img src="/kalshi-icon.png" alt="K" className="w-4 h-4 rounded-sm" />
                      </a>
                      <a href={market.polymarketUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 p-1 rounded hover:bg-[#a855f7]/20 opacity-70 hover:opacity-100 transition-opacity" title="Polymarket">
                        <img src="/polymarket-icon.png" alt="PM" className="w-4 h-4 rounded-sm" />
                      </a>
                      <button onClick={(e) => { e.stopPropagation(); onEditMarket(market, e); }} className="p-1 rounded hover:bg-[#262626] text-[#737373] hover:text-[#e5e5e5]"><Pencil className="w-3 h-3" /></button>
                      <button onClick={(e) => { e.stopPropagation(); onDeleteMarket(market.id); }} className="p-1 rounded hover:bg-[#ef4444]/20 text-[#737373] hover:text-[#ef4444]"><Trash2 className="w-3 h-3" /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {markets.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-[#737373]">No saved markets yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon, color, valueSize }: { label: string; value: string | number; icon: React.ReactNode; color: "green" | "blue" | "purple" | "yellow"; valueSize?: "xl" | "xs" }) {
  const colors: Record<typeof color, string> = {
    green: "bg-[#22c55e]/10 text-[#22c55e]",
    blue: "bg-[#3b82f6]/10 text-[#3b82f6]",
    purple: "bg-[#a855f7]/10 text-[#a855f7]",
    yellow: "bg-[#eab308]/10 text-[#eab308]",
  };
  return (
    <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-7 h-7 rounded-md flex items-center justify-center ${colors[color]}`}>{icon}</span>
        <span className="text-xs text-[#737373]">{label}</span>
      </div>
      <div className={`font-bold text-[#e5e5e5] ${valueSize === 'xs' ? 'text-xs' : 'text-xl'}`}>{value}</div>
    </div>
  );
}

function formatProfit(n: number) {
  return `$${n.toFixed(2)}`;
}

function formatDollar(n: number) {
  return `$${n.toFixed(2)}`;
}

function formatExpiry(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}


/* ── Manual Matching Panel ── */
interface ManualMatchingPanelProps {
  open: boolean;
  onToggle: () => void;
  kalshiUrl: string;
  pmUrl: string;
  pmSlug: string;
  unmatchedKalshi: UnmatchedKalshi[];
  unmatchedPolymarket: UnmatchedPolymarket[];
  manualMatches: ManualMatch[];
  selectedKalshi: UnmatchedKalshi | null;
  selectedPM: UnmatchedPolymarket | null;
  onSelectKalshi: (k: UnmatchedKalshi | null) => void;
  onSelectPM: (p: UnmatchedPolymarket | null) => void;
  onCreateMatch: (kalshiTicker: string, pmConditionId: string, kalshiTitle?: string, pmTitle?: string) => void;
  onDeleteMatch: (id: string) => void;
  msg: string;
}

function ManualMatchingPanel({
  open, onToggle,
  kalshiUrl, pmUrl, pmSlug,
  unmatchedKalshi, unmatchedPolymarket,
  manualMatches, selectedKalshi, selectedPM,
  onSelectKalshi, onSelectPM,
  onCreateMatch, onDeleteMatch, msg,
}: ManualMatchingPanelProps) {
  const [kFilter, setKFilter] = useState("");
  const [pFilter, setPFilter] = useState("");

  const filteredKalshi = unmatchedKalshi.filter(k =>
    k.title.toLowerCase().includes(kFilter.toLowerCase()) ||
    k.ticker.toLowerCase().includes(kFilter.toLowerCase())
  );
  const filteredPM = unmatchedPolymarket.filter(p =>
    p.title.toLowerCase().includes(pFilter.toLowerCase()) ||
    p.conditionId.toLowerCase().includes(pFilter.toLowerCase())
  );

  const activeMatchIds = new Map<string, ManualMatch>();
  for (const m of manualMatches) activeMatchIds.set(`${m.kalshiTicker}|${m.pmConditionId}`, m);

  return (
    <aside className={`shrink-0 border-l border-[#1a1a1a] bg-[#0f0f0f] flex flex-col transition-all duration-300 ${open ? "w-96" : "w-14"}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-[#1a1a1a]">
        {open && (
          <div className="flex items-center gap-2">
            <Hand className="w-4 h-4 text-[#eab308]" />
            <span className="text-sm font-semibold">Manual Match</span>
          </div>
        )}
        <button onClick={onToggle} className="p-1.5 rounded-md hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors">
          {open ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      {!open && (
        <div className="flex-1 flex flex-col items-center gap-4 py-4">
          <Hand className="w-4 h-4 text-[#eab308]" />
          {manualMatches.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#eab308]/10 text-[#eab308]">{manualMatches.length}</span>
          )}
        </div>
      )}

      {open && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Kalshi unmatched */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-[#a3a3a3] uppercase">Kalshi ({unmatchedKalshi.length})</h3>
              <input
                type="text"
                value={kFilter}
                onChange={(e) => setKFilter(e.target.value)}
                placeholder="Search..."
                className="px-2 py-1 rounded-md bg-[#1a1a1a] border border-[#262626] text-xs text-[#e5e5e5] w-28"
              />
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-[#1a1a1a]">
              {filteredKalshi.map((k) => {
                const isActive = activeMatchIds.has(`${k.ticker}|${(selectedPM?.conditionId ?? '')}`);
                const isSelected = selectedKalshi?.ticker === k.ticker;
                return (
                  <div
                    key={k.ticker}
                    onClick={() => onSelectKalshi(isSelected ? null : k)}
                    className={`px-2 py-1.5 cursor-pointer transition-colors text-xs ${
                      isSelected ? "bg-[#eab308]/10 text-[#eab308]" : "hover:bg-[#1a1a1a] text-[#a3a3a3]"
                    }`}
                  >
                    <div className="font-medium truncate">{k.title}</div>
                    <div className="text-[10px] text-[#737373]">YES {k.yesAsk.toFixed(2)} NO {k.noAsk.toFixed(2)}</div>
                  </div>
                );
              })}
              {filteredKalshi.length === 0 && <div className="px-2 py-3 text-xs text-[#525252]">No unmatched Kalshi markets.</div>}
            </div>
          </div>

          {/* Polymarket unmatched */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-[#a3a3a3] uppercase">Polymarket ({unmatchedPolymarket.length})</h3>
              <input
                type="text"
                value={pFilter}
                onChange={(e) => setPFilter(e.target.value)}
                placeholder="Search..."
                className="px-2 py-1 rounded-md bg-[#1a1a1a] border border-[#262626] text-xs text-[#e5e5e5] w-28"
              />
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-[#1a1a1a]">
              {filteredPM.map((p) => {
                const isActive = activeMatchIds.has(`${(selectedKalshi?.ticker ?? '')}|${p.conditionId}`);
                const isSelected = selectedPM?.conditionId === p.conditionId;
                return (
                  <div
                    key={p.conditionId}
                    onClick={() => onSelectPM(isSelected ? null : p)}
                    className={`px-2 py-1.5 cursor-pointer transition-colors text-xs ${
                      isSelected ? "bg-[#eab308]/10 text-[#eab308]" : "hover:bg-[#1a1a1a] text-[#a3a3a3]"
                    }`}
                  >
                    <div className="font-medium truncate">{p.title}</div>
                    <div className="text-[10px] text-[#737373]">YES {p.yesPrice.toFixed(2)} NO {p.noPrice.toFixed(2)}</div>
                  </div>
                );
              })}
              {filteredPM.length === 0 && <div className="px-2 py-3 text-xs text-[#525252]">No unmatched Polymarket markets.</div>}
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-[#a3a3a3] uppercase">Actions</h3>
            <div className="rounded-lg bg-[#111111] border border-[#1a1a1a] p-3 space-y-2">
              <div className="text-xs text-[#737373]">Selected:</div>
              {selectedKalshi && (
                <div className="text-xs text-[#e5e5e5] truncate">
                  <span className="text-[#eab308]">Kalshi:</span> {selectedKalshi.title}
                </div>
              )}
              {selectedPM && (
                <div className="text-xs text-[#e5e5e5] truncate">
                  <span className="text-[#eab308]">PM:</span> {selectedPM.title}
                </div>
              )}
              {!selectedKalshi && !selectedPM && (
                <div className="text-xs text-[#525252]">Click one market from each side.</div>
              )}
              <button
                onClick={() => {
                  if (selectedKalshi && selectedPM) {
                    onCreateMatch(selectedKalshi.ticker, selectedPM.conditionId, selectedKalshi.title, selectedPM.title);
                  }
                }}
                disabled={!selectedKalshi || !selectedPM}
                className="w-full px-3 py-2 rounded-lg bg-[#eab308] text-black text-xs font-semibold hover:bg-[#ca8a04] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                <div className="flex items-center justify-center gap-1.5">
                  <Link2 className="w-3 h-3" />
                  Link Markets
                </div>
              </button>
            </div>

            {/* Existing manual matches */}
            {manualMatches.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-semibold text-[#a3a3a3] uppercase pt-2">Saved Links</div>
                <div className="max-h-44 overflow-y-auto space-y-1">
                  {manualMatches.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-[#1a1a1a]">
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-[#737373] truncate">
                          <span className="text-[#eab308]">K:</span> {m.kalshiTitle} {' <-> '} <span className="text-[#eab308]">PM:</span> {m.pmTitle}
                        </div>
                      </div>
                      <button onClick={() => onDeleteMatch(m.id)} className="p-1 rounded hover:bg-[#ef4444]/20 text-[#737373] hover:text-[#ef4444] transition-colors">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
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
  onFetch,
  onSync,
  onSaveToH2H,
}: {
  markets: any[];
  savedMarketUrls: { kalshi: string; pm: string }[];
  loading: boolean;
  syncing: boolean;
  error: string;
  lastSync: any;
  savingIds: Set<string>;
  onFetch: () => void;
  onSync: () => void;
  onSaveToH2H: (m: any) => void;
}) {
  useEffect(() => {
    onFetch();
  }, []);

  const sorted = [...markets].filter((m) => {
    // Hide markets already saved — match normalized URLs (case-insensitive, strip query params)
    const normalizeUrl = (url: string) => (url || '').split('?')[0].replace(/\/$/, '').toLowerCase();
    const kUrl = normalizeUrl(m.kalshiUrl);
    const pmUrl = normalizeUrl(m.polymarketUrl);
    if (!kUrl && !pmUrl) return false;
    return !savedMarketUrls.some(
      (saved) => (kUrl && normalizeUrl(saved.kalshi) === kUrl) || (pmUrl && normalizeUrl(saved.pm) === pmUrl)
    );
  }).sort((a, b) => {
    const da = a.eventDate ? new Date(a.eventDate).getTime() : Infinity;
    const db = b.eventDate ? new Date(b.eventDate).getTime() : Infinity;
    return da - db;
  });

  /* Check per-row if already saved (for button state) */
  const isMarketSaved = (m: any) => {
    const normalizeUrl = (url: string) => (url || '').split('?')[0].replace(/\/$/, '').toLowerCase();
    const kUrl = normalizeUrl(m.kalshiUrl);
    const pmUrl = normalizeUrl(m.polymarketUrl);
    return savedMarketUrls.some(
      (saved) => (kUrl && normalizeUrl(saved.kalshi) === kUrl) || (pmUrl && normalizeUrl(saved.pm) === pmUrl)
    );
  };

  const hiddenCount = markets.length - sorted.length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Globe className="w-5 h-5 text-[#22c55e]" />
            MarketFinder
          </h2>
          <p className="text-xs text-[#737373] mt-0.5">
            PredictionHunt matched markets — sorted by expiry soonest
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastSync && (
            <span className="text-[10px] text-[#525252]">
              Last sync: {getTimeAgo(lastSync.finishedAt || lastSync.startedAt)}
            </span>
          )}
          <button
            onClick={onSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#22c55e]/10 text-[#22c55e] text-sm font-medium hover:bg-[#22c55e]/20 transition-all border border-[#22c55e]/20 disabled:opacity-50"
          >
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {syncing ? "Syncing..." : "Sync All"}
          </button>
        </div>
      </div>

      {hiddenCount > 0 && (
        <div className="text-xs text-[#737373] flex items-center gap-2 px-3 py-2 rounded-lg bg-[#1a1a1a]/50">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" className="text-[#22c55e]"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          {hiddenCount} market{hiddenCount !== 1 ? 's' : ''} hidden (already in H2H)
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-[#ef4444]">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center text-sm text-[#737373]">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
          Loading markets...
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-20 text-center text-sm text-[#525252]">
          No markets found. Try syncing to fetch from PredictionHunt.
        </div>
      ) : (
        <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#111111] border-b border-[#1a1a1a]">
              <tr className="text-[10px] text-[#737373] uppercase tracking-wider">
                <th className="text-left px-4 py-3 font-medium">Market</th>
                <th className="text-left px-4 py-3 font-medium w-40">Expiry</th>
                <th className="text-left px-4 py-3 font-medium w-24"></th>
                <th className="text-left px-4 py-3 font-medium w-24"></th>
                <th className="text-center px-4 py-3 font-medium w-32"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1a1a1a]">
              {sorted.map((m) => {
                const isSaving = savingIds.has(m.id);
                return (
                  <tr key={m.id} className="hover:bg-[#1a1a1a]/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#e5e5e5] text-sm">{m.title}</div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-[#1a1a1a] text-[#737373]">{m.eventType}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-[#e5e5e5]">
                        {m.eventDate ? new Date(m.eventDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {m.kalshiUrl ? (
                        <a href={m.kalshiUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-[#eab308] hover:underline">Kalshi →</a>
                      ) : (
                        <span className="text-xs text-[#525252]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {m.polymarketUrl ? (
                        <a href={m.polymarketUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-[#6366f1] hover:underline">Polymarket →</a>
                      ) : (
                        <span className="text-xs text-[#525252]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {isMarketSaved(m) ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/20">
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>
                          Added
                        </span>
                      ) : (
                        <button
                          onClick={() => onSaveToH2H(m)}
                          disabled={isSaving || !m.kalshiUrl || !m.polymarketUrl}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[#22c55e]/10 text-[#22c55e] hover:bg-[#22c55e]/20 transition-colors border border-[#22c55e]/20 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          {isSaving ? "Saving..." : "Add to H2H"}
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
