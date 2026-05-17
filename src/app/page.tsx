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
} from "lucide-react";

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
}

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

  // Load saved markets on mount
  useEffect(() => {
    loadSavedMarkets();
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
    } catch {
      // silently fail on load
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
          eventTitle: result.eventTitle,
        }),
      });
      if (res.ok) {
        await loadSavedMarkets();
      }
    } catch (e: any) {
      setError("Failed to save: " + e.message);
    } finally {
      setSaving(false);
    }
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
    // Trigger scan after state update
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

  // Stop polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
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

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] flex">
      {/* Sidebar */}
      <aside
        className={`shrink-0 border-r border-[#1a1a1a] bg-[#0f0f0f] flex flex-col transition-all duration-300 ${
          sidebarOpen ? "w-72" : "w-14"
        }`}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-[#1a1a1a]">
          {sidebarOpen && (
            <div className="flex items-center gap-2">
              <Bookmark className="w-4 h-4 text-[#22c55e]" />
              <span className="text-sm font-semibold">Saved Markets</span>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 rounded-md hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"
          >
            {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </div>

        {/* Overview button */}
        <button
          onClick={goToOverview}
          className={`flex items-center gap-2 px-3 py-2.5 mx-2 mt-2 rounded-lg text-sm transition-colors ${
            viewMode === "overview"
              ? "bg-[#22c55e]/10 text-[#22c55e]"
              : "bg-[#1a1a1a] text-[#a3a3a3] hover:bg-[#262626] hover:text-[#e5e5e5]"
          }`}
        >
          <BarChart3 className="w-4 h-4 shrink-0" />
          {sidebarOpen && <span>Overview</span>}
        </button>

        {/* New scan button */}
        <button
          onClick={goToNewScan}
          className="flex items-center gap-2 px-3 py-2.5 mx-2 mt-1 rounded-lg bg-[#1a1a1a] hover:bg-[#262626] text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors text-sm"
        >
          <Plus className="w-4 h-4 shrink-0" />
          {sidebarOpen && <span>New Scan</span>}
        </button>

        {/* Saved markets list */}
        <div className="flex-1 overflow-y-auto py-2 space-y-1 px-2">
          {savedMarkets.map((market) => (
            <div
              key={market.id}
              onClick={() => loadMarket(market)}
              className={`group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors text-sm ${
                activeMarketId === market.id && viewMode === "scan"
                  ? "bg-[#22c55e]/10 text-[#22c55e]"
                  : "text-[#a3a3a3] hover:bg-[#1a1a1a] hover:text-[#e5e5e5]"
              }`}
            >
              <Bookmark className="w-3.5 h-3.5 shrink-0" />
              {sidebarOpen && (
                <>
                  <span className="truncate flex-1">{market.eventTitle}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMarket(market.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[#ef4444]/20 text-[#737373] hover:text-[#ef4444] transition-opacity"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          ))}
          {savedMarkets.length === 0 && sidebarOpen && (
            <div className="px-2 py-4 text-xs text-[#525252] text-center">
              No saved markets yet.
              <br />
              Scan and save one!
            </div>
          )}
        </div>

        {/* Sidebar footer */}
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
                    <span className="w-2 h-2 rounded-full bg-[#22c55e] animate-pulse" />
                    Live
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
                <button
                  onClick={stopPolling}
                  className="px-3 py-1.5 text-xs rounded-md bg-[#1a1a1a] hover:bg-[#262626] text-[#e5e5e5] transition-colors"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="max-w-7xl mx-auto px-4 py-6">
          {viewMode === "overview" ? (
            <OverviewPanel savedMarkets={savedMarkets} onSelectMarket={loadMarket} />
          ) : (
            <>
              {/* Scan inputs */}
              <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] p-5 mb-6">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm font-medium text-[#a3a3a3]">
                      <Link2 className="w-4 h-4" /> Kalshi URL
                    </label>
                    <input
                      type="text"
                      value={kalshiUrl}
                      onChange={(e) => setKalshiUrl(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] placeholder-[#525252] focus:outline-none focus:border-[#22c55e] focus:ring-1 focus:ring-[#22c55e]/30 transition-all"
                      placeholder="https://kalshi.com/markets/..."
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm font-medium text-[#a3a3a3]">
                      <Link2 className="w-4 h-4" /> Polymarket URL
                    </label>
                    <input
                      type="text"
                      value={pmUrl}
                      onChange={(e) => setPmUrl(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] placeholder-[#525252] focus:outline-none focus:border-[#22c55e] focus:ring-1 focus:ring-[#22c55e]/30 transition-all"
                      placeholder="https://polymarket.com/event/..."
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={() => handleScan(false)}
                    disabled={loading}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#22c55e] text-black font-semibold text-sm hover:bg-[#16a34a] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scan className="w-4 h-4" />}
                    {loading ? "Scanning..." : "Scan Markets"}
                  </button>

                  {/* Save button */}
                  {result && (
                    <button
                      onClick={saveCurrentMarket}
                      disabled={saving}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-[#e5e5e5] text-sm hover:bg-[#262626] transition-all disabled:opacity-50"
                    >
                      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                      {saving ? "Saving..." : "Save Market"}
                    </button>
                  )}

                  <div className="flex items-center gap-2 ml-auto">
                    <label className="text-xs text-[#737373]">Capital:</label>
                    <input
                      type="number"
                      value={capital}
                      onChange={(e) => setCapital(Number(e.target.value))}
                      className="w-24 px-2 py-1.5 rounded-md bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] focus:outline-none focus:border-[#22c55e]"
                    />
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
                  {/* Stats */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatCard label="Kalshi Markets" value={result.kalshiCount} icon={<Activity className="w-4 h-4" />} color="blue" />
                    <StatCard label="Polymarket Markets" value={result.pmCount} icon={<Activity className="w-4 h-4" />} color="purple" />
                    <StatCard label="Matched Pairs" value={result.matchedCount} icon={<Link2 className="w-4 h-4" />} color="green" />
                    <StatCard label="Event" value={result.eventTitle.length > 20 ? result.eventTitle.slice(0, 20) + "..." : result.eventTitle} icon={<Clock className="w-4 h-4" />} color="yellow" />
                  </div>

                  {/* Table */}
                  <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] overflow-hidden">
                    <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center justify-between">
                      <h2 className="text-sm font-semibold">All Outcomes · {result.outcomes.length}</h2>
                      <div className="flex items-center gap-2 text-xs text-[#737373]">
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-[#22c55e]" /> Matched
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-[#262626]" /> Single
                        </span>
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
                            <th
                              className="px-4 py-2 text-center font-medium cursor-pointer hover:text-[#e5e5e5] select-none"
                              onClick={() => {
                                if (sortField === "roi") setSortDirection((p) => (p === "desc" ? "asc" : "desc"));
                                else {
                                  setSortField("roi");
                                  setSortDirection("desc");
                                }
                              }}
                            >
                              <div className="flex items-center justify-center gap-1">
                                Arbitrage
                                {sortField === "roi" && (
                                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={sortDirection === "asc" ? "rotate-180" : ""}>
                                    <polyline points="6 9 12 15 18 9" />
                                  </svg>
                                )}
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
                              <tr
                                key={`${outcome.artist}-${idx}`}
                                className={`transition-colors ${isMatched ? "bg-[#22c55e]/[0.02]" : ""} hover:bg-[#1a1a1a]/50 ${
                                  priceFlash === "up" ? "bg-[#22c55e]/[0.15]" : priceFlash === "down" ? "bg-[#ef4444]/[0.15]" : ""
                                } ${priceFlash ? "animate-pulse" : ""}`}
                              >
                                <td className="px-4 py-3">
                                  <div className="flex items-center gap-2">
                                    <span className={`text-sm font-medium ${isMatched ? "text-[#22c55e]" : "text-[#a3a3a3]"}`}>{outcome.artist}</span>
                                    {isMatched && <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#22c55e]/10 text-[#22c55e]">MATCHED</span>}
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-center">
                                  {outcome.kalshi ? (
                                    <div>
                                      <div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.kalshi.yesAsk)}</div>
                                      {outcome.kalshi.yesAskDepth && (
                                        <div className="text-[10px] text-[#737373]">({outcome.kalshi.yesAskDepth})</div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-[#404040]">—</span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  {outcome.kalshi ? (
                                    <div>
                                      <div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.kalshi.noAsk)}</div>
                                      {outcome.kalshi.noAskDepth && (
                                        <div className="text-[10px] text-[#737373]">({outcome.kalshi.noAskDepth})</div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-[#404040]">—</span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  {outcome.polymarket ? (
                                    <div>
                                      <div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.polymarket.yesPrice)}</div>
                                      {(outcome.polymarket.askDepth ?? 0) > 0 && (
                                        <div className="text-[10px] text-[#737373]">(${Math.round(outcome.polymarket.askDepth!)})</div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-[#404040]">—</span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  {outcome.polymarket ? (
                                    <div>
                                      <div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.polymarket.noPrice)}</div>
                                      {(outcome.polymarket.askDepth ?? 0) > 0 && (
                                        <div className="text-[10px] text-[#737373]">(${Math.round(outcome.polymarket.askDepth!)})</div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-[#404040]">—</span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  {isMatched ? (
                                    <div className="flex flex-col items-center">
                                      <span className={`text-xs font-bold ${hasArb ? "text-[#22c55e]" : "text-[#737373]"}`}>
                                        {hasArb ? `+${arb.roiPct.toFixed(2)}%` : "No arb"}
                                      </span>
                                      {hasArb && <span className="text-[10px] text-[#737373]">{formatDollar(arb.expectedProfit)} profit</span>}
                                    </div>
                                  ) : (
                                    <span className="text-[#404040]">—</span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    {outcome.kalshi && (
                                      <a href={kalshiDeepLink(outcome.kalshi.ticker)} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors">
                                        <ExternalLink className="w-3.5 h-3.5" />
                                      </a>
                                    )}
                                    {outcome.polymarket && (
                                      <a href={pmDeepLink(result.pmEventSlug)} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors">
                                        <ExternalLink className="w-3.5 h-3.5" />
                                      </a>
                                    )}
                                    {isMatched && (
                                      <button
                                        onClick={() => setExpandedArtist(isExpanded ? null : outcome.artist)}
                                        className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"
                                      >
                                        <TrendingUp className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                                      </button>
                                    )}
                                  </div>
                                </td>
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
    </div>
  );
}

function OverviewPanel({ savedMarkets, onSelectMarket }: { savedMarkets: SavedMarket[]; onSelectMarket: (m: SavedMarket) => void }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Market Overview</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {savedMarkets.map((market) => (
          <div
            key={market.id}
            onClick={() => onSelectMarket(market)}
            className="p-4 rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] hover:border-[#22c55e]/30 cursor-pointer transition-all"
          >
            <h3 className="text-sm font-medium text-[#e5e5e5] mb-2">{market.eventTitle}</h3>
            <div className="space-y-1 text-xs text-[#737373]">
              <div className="flex items-center gap-1"><Link2 className="w-3 h-3" /><span className="truncate">{market.kalshiUrl}</span></div>
              <div className="flex items-center gap-1"><Link2 className="w-3 h-3" /><span className="truncate">{market.polymarketUrl}</span></div>
            </div>
            <div className="mt-3 text-[10px] text-[#525252]">
              Saved {new Date(market.createdAt).toLocaleDateString()}
            </div>
          </div>
        ))}
        {savedMarkets.length === 0 && (
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
