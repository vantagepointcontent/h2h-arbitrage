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
  Trash2,
  ChevronLeft,
  ChevronRight,
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
} from "lucide-react";
import { DateTimePicker } from "@/components/DateTimePicker";

interface ArbitrageInfo {
  strategy: string;
  kalshiStake: number;
  pmStake: number;
  expectedProfit: number;
  roiPct: number;
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
  } | null;
  arbitrage: ArbitrageInfo;
}

interface ScanResult {
  eventTitle: string;
  kalshiEventTicker: string;
  pmEventSlug: string;
  pmEventId: string;
  kalshiCount: number;
  pmCount: number;
  matchedCount: number;
  outcomes: UnifiedOutcome[];
}

interface SavedMarket {
  id: string;
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
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
  } | null;
}

type OverviewSort = "expiry" | "roi" | "name";

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
  const [sortField, setSortField] = useState<"roi" | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [lastScanTime, setLastScanTime] = useState<number>(0);
  const previousPricesRef = useRef<Map<string, { kYes: number; pYes: number }>>(new Map());
  const [priceChanges, setPriceChanges] = useState<Map<string, "up" | "down" | null>>(new Map());
  const [pollTimer, setPollTimer] = useState<number>(Date.now());
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const [savedMarkets, setSavedMarkets] = useState<SavedMarket[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeMarketId, setActiveMarketId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"scan" | "overview">("scan");

  // Save modal state
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveExpiry, setSaveExpiry] = useState<string | null>(null);

  // Edit modal state (for editing existing market name/expiry)
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editMarketId, setEditMarketId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editExpiry, setEditExpiry] = useState<string | null>(null);

  // Overview sort
  const [overviewSort, setOverviewSort] = useState<OverviewSort>("expiry");
  const [overviewSortDir, setOverviewSortDir] = useState<"asc" | "desc">("asc");

  // Load saved markets on mount
  useEffect(() => { loadSavedMarkets(); }, []);

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
      }
    } catch {}
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
          expiryDate: saveExpiry,
        }),
      });
      if (res.ok) {
        await loadSavedMarkets();
        setSaveModalOpen(false);
        setSaveName("");
        setSaveExpiry(null);
      }
    } catch (e: any) {
      setError("Failed to save: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const updateMarketMeta = async (id: string, updates: { eventTitle?: string; expiryDate?: string | null }) => {
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

  const loadMarket = (market: SavedMarket) => {
    setKalshiUrl(market.kalshiUrl);
    setPmUrl(market.polymarketUrl);
    setActiveMarketId(market.id);
    setViewMode("scan");
    setResult(null);
    setError("");
    setTimeout(() => handleScan(false), 0);
  };

  const goToNewScan = () => {
    setKalshiUrl("");
    setPmUrl("");
    setResult(null);
    setActiveMarketId(null);
    setError("");
    stopPolling();
    setViewMode("scan");
  };

  const goToOverview = () => {
    stopPolling();
    setViewMode("overview");
    setActiveMarketId(null);
  };

  const scan = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/scan?_=${Date.now()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ kalshiUrl, polymarketUrl: pmUrl }),
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
      setLastUpdated(new Date());
      setLastScanTime(data._ts || Date.now());
    } catch (err: any) {
      if (!silent) setError(err.message || "Scan failed");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [kalshiUrl, pmUrl]);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setIsPolling(true);
    pollRef.current = setInterval(() => scan(true), 1000);
  }, [scan]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setIsPolling(false);
  }, []);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const handleScan = async (silent = false) => {
    await scan(silent);
    if (!silent) startPolling();
  };

  const formatPrice = (p: number) => `${(p * 100).toFixed(1)}¢`;
  const formatDollar = (n: number) => `$${n.toFixed(2)}`;

  const kalshiDeepLink = (ticker: string) => `https://kalshi.com/markets/${ticker}`;
  const pmDeepLink = (slug: string) => `https://polymarket.com/event/${slug}`;

  const sortedData = (() => {
    if (!result) return [];
    const arr = result.outcomes.slice();
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
    setSaveExpiry(null);
    setSaveModalOpen(true);
  };

  const openEditModal = (market: SavedMarket, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditMarketId(market.id);
    setEditName(market.eventTitle);
    setEditExpiry(market.expiryDate ?? null);
    setEditModalOpen(true);
  };

  const handleEditSave = async () => {
    if (!editMarketId) return;
    await updateMarketMeta(editMarketId, {
      eventTitle: editName,
      expiryDate: editExpiry,
    });
    setEditModalOpen(false);
    setEditMarketId(null);
  };

  // Overview sorted markets
  const sortedOverviewMarkets = (() => {
    const arr = [...savedMarkets];
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
    } else {
      arr.sort((a, b) => {
        const cmp = a.eventTitle.localeCompare(b.eventTitle);
        return overviewSortDir === "asc" ? cmp : -cmp;
      });
    }
    return arr;
  })();

  const toggleOverviewSort = (field: OverviewSort) => {
    if (overviewSort === field) setOverviewSortDir(d => d === "asc" ? "desc" : "asc");
    else { setOverviewSort(field); setOverviewSortDir(field === "roi" ? "desc" : "asc"); }
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
      <aside className={`shrink-0 border-r border-[#1a1a1a] bg-[#0f0f0f] flex flex-col transition-all duration-300 ${sidebarOpen ? "w-72" : "w-14"}`}>
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

        <button onClick={goToNewScan} className="flex items-center gap-2 px-3 py-2.5 mx-2 mt-1 rounded-lg bg-[#1a1a1a] hover:bg-[#262626] text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors text-sm">
          <Plus className="w-4 h-4 shrink-0" />
          {sidebarOpen && <span>New Scan</span>}
        </button>

        <div className="flex-1 overflow-y-auto py-2 space-y-1 px-2">
          {savedMarkets.map((market) => {
            const last = market.lastScanResult;
            const hasPositive = last && last.bestRoiPct > 0;
            return (
              <div key={market.id} onClick={() => loadMarket(market)} className={`group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors text-sm ${activeMarketId === market.id && viewMode === "scan" ? "bg-[#22c55e]/10 text-[#22c55e]" : "text-[#a3a3a3] hover:bg-[#1a1a1a] hover:text-[#e5e5e5]"}`}>
                <Bookmark className="w-3.5 h-3.5 shrink-0" />
                {sidebarOpen && (
                  <>
                    <span className="truncate flex-1">{market.eventTitle}</span>
                    {last && (
                      <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${hasPositive ? "bg-[#22c55e]/20 text-[#22c55e]" : "bg-[#262626] text-[#737373]"}`}>
                        {hasPositive ? `+${last.bestRoiPct.toFixed(2)}%` : "0%"}
                      </span>
                    )}
                    <button onClick={(e) => openEditModal(market, e)} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[#262626] text-[#737373] hover:text-[#e5e5e5] transition-opacity">
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); deleteMarket(market.id); }} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[#ef4444]/20 text-[#737373] hover:text-[#ef4444] transition-opacity">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {savedMarkets.length === 0 && sidebarOpen && (
            <div className="px-2 py-4 text-xs text-[#525252] text-center">No saved markets yet.<br />Scan and save one!</div>
          )}
        </div>

        {sidebarOpen && (
          <div className="px-3 py-2 border-t border-[#1a1a1a] text-[10px] text-[#525252]">
            {savedMarkets.length} market{savedMarkets.length !== 1 ? "s" : ""} saved
          </div>
        )}
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
            />
          ) : (
            <>
              {/* Scan inputs */}
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

              {/* Results */}
              {result && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatCard label="Kalshi Markets" value={result.kalshiCount} icon={<Activity className="w-4 h-4" />} color="blue" />
                    <StatCard label="Polymarket Markets" value={result.pmCount} icon={<Activity className="w-4 h-4" />} color="purple" />
                    <StatCard label="Matched Pairs" value={result.matchedCount} icon={<Link2 className="w-4 h-4" />} color="green" />
                    <StatCard label="Event" value={result.eventTitle.length > 20 ? result.eventTitle.slice(0, 20) + "..." : result.eventTitle} icon={<Clock className="w-4 h-4" />} color="yellow" />
                  </div>

                  <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] overflow-hidden">
                    <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center justify-between">
                      <h2 className="text-sm font-semibold">All Outcomes · {result.outcomes.length}</h2>
                      <div className="flex items-center gap-2 text-xs text-[#737373]">
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#22c55e]" /> Matched</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#262626]" /> Single</span>
                      </div>
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
                              <tr key={`${outcome.artist}-${idx}`} className={`transition-colors ${isMatched ? "bg-[#22c55e]/[0.02]" : ""} hover:bg-[#1a1a1a]/50 ${priceFlash === "up" ? "bg-[#22c55e]/[0.15]" : priceFlash === "down" ? "bg-[#ef4444]/[0.15]" : ""} ${priceFlash ? "animate-pulse" : ""}`}>
                                <td className="px-4 py-3"><div className="flex items-center gap-2"><span className={`text-sm font-medium ${isMatched ? "text-[#22c55e]" : "text-[#a3a3a3]"}`}>{outcome.artist}</span>{isMatched && <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#22c55e]/10 text-[#22c55e]">MATCHED</span>}</div></td>
                                <td className="px-4 py-3 text-center">{outcome.kalshi ? (<div><div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.kalshi.yesAsk)}</div>{outcome.kalshi.yesAskDepth && (<div className="text-[10px] text-[#737373]">({outcome.kalshi.yesAskDepth})</div>)}</div>) : (<span className="text-[#404040]">—</span>)}</td>
                                <td className="px-4 py-3 text-center">{outcome.kalshi ? (<div><div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.kalshi.noAsk)}</div>{outcome.kalshi.noAskDepth && (<div className="text-[10px] text-[#737373]">({outcome.kalshi.noAskDepth})</div>)}</div>) : (<span className="text-[#404040]">—</span>)}</td>
                                <td className="px-4 py-3 text-center">{outcome.polymarket ? (<div><div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.polymarket.yesPrice)}</div>{(outcome.polymarket.askDepth ?? 0) > 0 && (<div className="text-[10px] text-[#737373]">(${Math.round(outcome.polymarket.askDepth!)})</div>)}</div>) : (<span className="text-[#404040]">—</span>)}</td>
                                <td className="px-4 py-3 text-center">{outcome.polymarket ? (<div><div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.polymarket.noPrice)}</div>{(outcome.polymarket.askDepth ?? 0) > 0 && (<div className="text-[10px] text-[#737373]">(${Math.round(outcome.polymarket.askDepth!)})</div>)}</div>) : (<span className="text-[#404040]">—</span>)}</td>
                                <td className="px-4 py-3 text-center">{isMatched ? (<div className="flex flex-col items-center"><span className={`text-xs font-bold ${hasArb ? "text-[#22c55e]" : "text-[#737373]"}`}>{hasArb ? `+${arb.roiPct.toFixed(2)}%` : "No arb"}</span>{hasArb && <span className="text-[10px] text-[#737373]">{formatDollar(arb.expectedProfit)} profit</span>}</div>) : (<span className="text-[#404040]">—</span>)}</td>
                                <td className="px-4 py-3 text-right"><div className="flex items-center justify-end gap-1">{outcome.kalshi && (<a href={kalshiDeepLink(outcome.kalshi.ticker)} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"><ExternalLink className="w-3.5 h-3.5" /></a>)}{outcome.polymarket && (<a href={pmDeepLink(result.pmEventSlug)} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"><ExternalLink className="w-3.5 h-3.5" /></a>)}{isMatched && (<button onClick={() => setExpandedArtist(isExpanded ? null : outcome.artist)} className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"><TrendingUp className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`} /></button>)}</div></td>
                              </tr>
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
              <label className="text-sm font-medium text-[#a3a3a3]">Expiry Date</label>
              <DateTimePicker value={saveExpiry} onChange={setSaveExpiry} placeholder="No expiry set" />
            </div>

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
}: {
  markets: SavedMarket[];
  onSelectMarket: (m: SavedMarket) => void;
  onEditMarket: (m: SavedMarket, e: React.MouseEvent) => void;
  onDeleteMarket: (id: string) => void;
  sort: OverviewSort;
  sortDir: "asc" | "desc";
  onToggleSort: (field: OverviewSort) => void;
  timeUntilExpiry: (iso: string | null | undefined) => string | null;
}) {
  return (
    <div className="space-y-5">
      {/* Header + sort controls */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Market Overview</h2>
        <div className="flex items-center gap-2">
          {(["expiry", "roi", "name"] as OverviewSort[]).map((field) => (
            <button
              key={field}
              onClick={() => onToggleSort(field)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sort === field
                  ? "bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/30"
                  : "bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] border border-transparent"
              }`}
            >
              {field === "expiry" ? "Expiry" : field === "roi" ? "Best Arb" : "Name"}
              {sort === field && (
                sortDir === "asc"
                  ? <ArrowUp className="w-3 h-3" />
                  : <ArrowDown className="w-3 h-3" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Flashcard grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {markets.map((market) => {
          const last = market.lastScanResult;
          const hasArb = last && last.bestRoiPct > 0;
          const ttl = timeUntilExpiry(market.expiryDate);
          const isExpired = ttl === "Expired";
          const scannedAgo = last ? getTimeAgo(last.scannedAt) : null;

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
              {/* Top row: name + edit/delete */}
              <div className="flex items-start justify-between mb-3">
                <h3 className="text-sm font-semibold text-[#e5e5e5] leading-tight pr-2">{market.eventTitle}</h3>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={(e) => onEditMarket(market, e)} className="p-1 rounded hover:bg-[#262626] text-[#737373] hover:text-[#e5e5e5]"><Pencil className="w-3 h-3" /></button>
                  <button onClick={(e) => { e.stopPropagation(); onDeleteMarket(market.id); }} className="p-1 rounded hover:bg-[#ef4444]/20 text-[#737373] hover:text-[#ef4444]"><Trash2 className="w-3 h-3" /></button>
                </div>
              </div>

              {/* Arb flash — the main number */}
              {last ? (
                <div className="mb-3">
                  <div className={`text-3xl font-bold tracking-tight ${hasArb ? "text-[#22c55e]" : "text-[#525252]"}`}>
                    {hasArb ? `+${last.bestRoiPct.toFixed(2)}%` : "0%"}
                  </div>
                  <div className="text-xs text-[#737373] mt-0.5">
                    {last.strategy} · {formatProfit(last.bestProfit)} profit
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
              <div className="flex items-center justify-between text-[10px] text-[#525252] pt-2 border-t border-[#1a1a1a]">
                <div className="flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {market.expiryDate ? (
                    <span className={isExpired ? "text-[#ef4444]" : "text-[#737373]"}>
                      {ttl} · {new Date(market.expiryDate).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  ) : (
                    <span>No expiry</span>
                  )}
                </div>
                {scannedAgo && (
                  <span className="text-[#525252]">Scanned {scannedAgo}</span>
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
    </div>
  );
}

function StatCard({ label, value, icon, color }: { label: string; value: string | number; icon: React.ReactNode; color: "green" | "blue" | "purple" | "yellow" }) {
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
      <div className="text-xl font-bold text-[#e5e5e5]">{value}</div>
    </div>
  );
}

function formatProfit(n: number) {
  return `$${n.toFixed(2)}`;
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
