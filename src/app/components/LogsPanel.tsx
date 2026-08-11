"use client";

import {
  FileText,
  Download,
  Filter,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  ChevronUp,
  ChevronDown,
  Search,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { classifyArbType, getArbTypeMeta, ARB_TYPES, type ArbType } from "@/lib/arb-types";
import { CompactStrategyDisplay } from "./ArbLegBreakdown";
import {
  buildHistoricalLegs,
  calculatePriceChange,
  type HistoricalPriceLeg,
  type QuoteOutcome,
  type QuotePlatform,
} from "@/lib/log-price-comparison";

interface LogEntry {
  id: number;
  market_id: string;
  best_roi_pct: number;
  best_profit: number;
  strategy: string;
  outcome_count: number;
  matched_count: number;
  kalshi_count: number;
  pm_count: number;
  positive_arb_count: number;
  total_stake: number;
  scanned_at: string;
  raw_result: string | null;
  market_title?: string | null;  // stored at scan time (BUG-030)
  market_name?: string | null;   // server-resolved (UI-015)
  category?: string | null;      // resolved from saved_markets (UI-015)
}

type ArbTypeFilter = "all" | ArbType;

const ARB_TYPE_FILTER_OPTIONS: { key: ArbTypeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "direct", label: "Direct" },
  { key: "cross", label: "Cross" },
  { key: "internal", label: "Internal" },
];

type EventType = "all" | "scan" | "arb" | "system";

const EVENT_TYPE_OPTIONS: { key: EventType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "scan", label: "Scan" },
  { key: "arb", label: "Arb" },
  { key: "system", label: "System" },
];

type SortKey = "scanned_at" | "best_roi_pct" | "best_profit" | "apy" | "positive_arb_count" | "matched_count";
type SortDir = "asc" | "desc";

export default function LogsPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [savedMarkets, setSavedMarkets] = useState<Map<string, { title: string; expiryDate?: string | null }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [minRoi, setMinRoi] = useState("");
  const [positiveArbOnly, setPositiveArbOnly] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [eventType, setEventType] = useState<EventType>("all");
  const [arbTypeFilter, setArbTypeFilter] = useState<ArbTypeFilter>("all");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const lastLogCountRef = useRef(0);

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("scanned_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Expand row
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  // UI-034: unique markets count from SQL COUNT(DISTINCT market_id)
  const [uniqueMarkets, setUniqueMarkets] = useState<number | null>(null);

  // UI-035: export row count estimate
  const [exportCount, setExportCount] = useState<number | null>(null);
  const [exportCountLoading, setExportCountLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError("");
    setNextCursor(undefined);
    try {
      const params = new URLSearchParams();
      params.set("limit", "100");
      if (minRoi) params.set("minRoi", minRoi);
      if (positiveArbOnly) params.set("positiveArbOnly", "true");
      if (fromDate) params.set("fromDate", fromDate);
      if (toDate) params.set("toDate", toDate);

      const res = await fetch(`/api/logs?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setLogs(data.logs || []);
        setNextCursor(data.nextCursor);
        setUniqueMarkets(typeof data.uniqueMarkets === "number" ? data.uniqueMarkets : null);
      }
    } catch (e: any) {
      setError(e.message || "Failed to fetch logs");
    } finally {
      setLoading(false);
    }
  }, [minRoi, positiveArbOnly, fromDate, toDate]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "100");
      params.set("before", nextCursor);
      if (minRoi) params.set("minRoi", minRoi);
      if (positiveArbOnly) params.set("positiveArbOnly", "true");
      if (fromDate) params.set("fromDate", fromDate);
      if (toDate) params.set("toDate", toDate);

      const res = await fetch(`/api/logs?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setLogs(prev => [...prev, ...(data.logs || [])]);
        setNextCursor(data.nextCursor);
        setUniqueMarkets(typeof data.uniqueMarkets === "number" ? data.uniqueMarkets : null);
      }
    } catch (e: any) {
      setError(e.message || "Failed to load more logs");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, minRoi, positiveArbOnly, fromDate, toDate]);

  useEffect(() => {
    const run = async () => { await fetchLogs(); };
    void run();
  }, [fetchLogs]);

  // Auto-refresh: poll every 15s for real-time log streaming
  useEffect(() => {
    if (!autoRefresh) return;
    const iv = setInterval(fetchLogs, 15000);
    return () => clearInterval(iv);
  }, [autoRefresh, fetchLogs]);

  // Fetch saved markets for market name lookup — use ultra-light names endpoint (~20KB vs 277KB)
  useEffect(() => {
    fetch("/api/saved-markets?fields=basic")
      .then((res) => res.json())
      .then((data) => {
        const m = new Map<string, { title: string; expiryDate?: string | null }>();
        const list = Array.isArray(data) ? data : (data?.markets ?? []);
        for (const mk of list) {
          if (mk.eventTitle) m.set(mk.id, { title: mk.eventTitle, expiryDate: mk.expiryDate });
        }
        setSavedMarkets(m);
      })
      .catch(() => {});
  }, []);

  // Filter by search query (market_id, market name, or strategy) + event type + arb type
  const filtered = useMemo(() => {
    let result = logs;
    
    // Event type filter
    if (eventType !== "all") {
      result = result.filter((l) => {
        if (eventType === "arb") return l.positive_arb_count > 0;
        if (eventType === "scan") return l.positive_arb_count === 0;
        if (eventType === "system") return l.matched_count === 0 || l.kalshi_count === 0 || l.pm_count === 0;
        return true;
      });
    }
    
    // Arb type filter
    if (arbTypeFilter !== "all") {
      result = result.filter((l) => classifyArbType(l.strategy) === arbTypeFilter);
    }
    
    if (!searchQuery.trim()) return result;
    const q = searchQuery.toLowerCase();
    return result.filter(
      (l) => {
        const marketName = l.market_name ?? l.market_title ?? savedMarkets.get(l.market_id)?.title;
        return (
          l.market_id?.toLowerCase().includes(q) ||
          marketName?.toLowerCase().includes(q) ||
          l.strategy?.toLowerCase().includes(q)
        );
      }
    );
  }, [logs, searchQuery, savedMarkets, eventType, arbTypeFilter]);

  // Sort
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let aVal: string | number = 0;
      let bVal: string | number = 0;
      switch (sortKey) {
        case "scanned_at":
          aVal = new Date(a.scanned_at).getTime();
          bVal = new Date(b.scanned_at).getTime();
          break;
        case "best_roi_pct":
          aVal = a.best_roi_pct;
          bVal = b.best_roi_pct;
          break;
        case "best_profit":
          aVal = a.best_profit;
          bVal = b.best_profit;
          break;
        case "apy":
          aVal = logApyPct(a) ?? 0;
          bVal = logApyPct(b) ?? 0;
          break;
        case "positive_arb_count":
          aVal = a.positive_arb_count;
          bVal = b.positive_arb_count;
          break;
        case "matched_count":
          aVal = a.matched_count;
          bVal = b.matched_count;
          break;
      }
      return sortDir === "asc" ? Number(aVal) - Number(bVal) : Number(bVal) - Number(aVal);
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // Build export URL with current filters
  const exportUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (minRoi) params.set("minRoi", minRoi);
    if (positiveArbOnly) params.set("positiveArbOnly", "true");
    if (fromDate) params.set("fromDate", fromDate);
    if (toDate) params.set("toDate", toDate);
    return `/api/logs/export?${params.toString()}`;
  }, [minRoi, positiveArbOnly, fromDate, toDate]);
  const tradeExportUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (fromDate) params.set("fromDate", fromDate);
    if (toDate) params.set("toDate", toDate);
    return `/api/logs/trades/export?${params.toString()}`;
  }, [fromDate, toDate]);
  // UI-035: estimate export row count from HEAD /api/logs/export
  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      setExportCountLoading(true);
      try {
        const res = await fetch(exportUrl, { method: "HEAD", cache: "no-store" });
        const count = res.headers.get("X-Export-Row-Count");
        if (!cancelled) setExportCount(count ? Number(count) : null);
      } catch {
        if (!cancelled) setExportCount(null);
      } finally {
        if (!cancelled) setExportCountLoading(false);
      }
    };
    void update();
    return () => { cancelled = true; };
  }, [exportUrl]);

  // UI-035: date-range presets
  const setDateRange = useCallback((preset: "today" | "7d" | "30d" | "month") => {
    const now = new Date();
    const iso = (d: Date) => d.toISOString().split("T")[0];
    let from: Date;
    let to: Date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    switch (preset) {
      case "today":
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case "7d":
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
        break;
      case "30d":
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
        break;
      case "month":
        from = new Date(now.getFullYear(), now.getMonth(), 1);
        to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        break;
    }
    setFromDate(iso(from));
    setToDate(iso(to));
  }, []);


  const exportEstimateText = useMemo(() => {
    if (exportCountLoading) return "Estimating export size...";
    if (exportCount === null) return "";
    return `This will export ${exportCount.toLocaleString()} row${exportCount === 1 ? "" : "s"}`;
  }, [exportCount, exportCountLoading]);

  // Arb type summary counts (from all logs, not filtered)
  const arbTypeCounts = useMemo(() => {
    let direct = 0, cross = 0, internal = 0;
    for (const l of logs) {
      const t = classifyArbType(l.strategy);
      if (t === 'direct') direct++;
      else if (t === 'cross') cross++;
      else if (t === 'internal') internal++;
    }
    return { direct, cross, internal };
  }, [logs]);

  // Stats summary
  const stats = useMemo(() => {
    if (!sorted.length) return null;
    const totalArbs = sorted.reduce((s, l) => s + (l.positive_arb_count ?? 0), 0);
    const avgRoi = sorted.reduce((s, l) => s + (l.best_roi_pct ?? 0), 0) / sorted.length;
    const bestRoi = Math.max(...sorted.map((l) => l.best_roi_pct ?? 0));
    const worstRoi = Math.min(...sorted.map((l) => l.best_roi_pct ?? 0));
    const totalProfit = sorted.reduce((s, l) => s + (l.best_profit ?? 0), 0);
    return { totalArbs, avgRoi, bestRoi, worstRoi, totalProfit, count: sorted.length };
  }, [sorted]);

  const fmtPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
  const fmtUsd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const fmtTime = (s: string) => {
    const d = new Date(s);
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <FileText className="w-5 h-5 text-[#5DBE81]" />
          Logs
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex min-h-11 items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              autoRefresh
                ? "bg-[#5DBE81]/10 text-[#5DBE81] border-[#5DBE81]/30"
                : "bg-[#182533] text-[#8A9BA8] border-[#182533] hover:text-[#FFFFFF]"
            }`}
            title="Auto-refresh every 15s for real-time streaming"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${autoRefresh ? "animate-spin" : ""}`} />
            {autoRefresh ? "Live" : "Auto"}
          </button>
          <button
            onClick={fetchLogs}
            className="flex min-h-11 items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#182533] text-[#8A9BA8] hover:bg-[#232E3C] hover:text-[#FFFFFF] text-xs font-medium transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <a
            href={exportUrl}
            className="flex min-h-11 items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#182533] text-[#8A9BA8] border border-[#182533] font-semibold text-xs hover:text-white transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export Scan CSV
          </a>
          <a
            href={tradeExportUrl}
            className="flex min-h-11 items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#5DBE81] text-black font-semibold text-xs hover:bg-[#4DA66E] transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export Trades CSV
          </a>
        </div>
      </div>

      {/* Export estimate */}
      {exportEstimateText && (
        <div className="text-xs text-[#8A9BA8] flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 text-[#5DBE81]" />
          {exportEstimateText}
        </div>
      )}

      {/* Stats Summary */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          <StatBox label="Total Scans" value={stats.count.toString()} />
          <StatBox label="Unique Markets" value={uniqueMarkets != null ? uniqueMarkets.toLocaleString() : "—"} color="#5DBE81" />
          <StatBox label="Total Arbs" value={stats.totalArbs.toString()} color="#5DBE81" />
          <StatBox label="Avg ROI" value={fmtPct(stats.avgRoi)} color={stats.avgRoi > 0 ? "#5DBE81" : "#ef4444"} />
          <StatBox label="Best ROI" value={fmtPct(stats.bestRoi)} color="#5DBE81" />
          <StatBox label="Total Profit" value={fmtUsd(stats.totalProfit)} color="#facc15" />
        </div>
      )}

      {/* Arb Type Summary */}
      {logs.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-[#8A9BA8] font-semibold uppercase tracking-wide">Arb Types:</span>
          <span className="flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${ARB_TYPES.direct.dotClass}`} />
            <span className="text-[#FFFFFF] font-medium">Direct:</span>
            <span className="text-emerald-400 font-mono font-semibold">{arbTypeCounts.direct}</span>
          </span>
          <span className="text-[#182533]">|</span>
          <span className="flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${ARB_TYPES.cross.dotClass}`} />
            <span className="text-[#FFFFFF] font-medium">Cross:</span>
            <span className="text-blue-400 font-mono font-semibold">{arbTypeCounts.cross}</span>
          </span>
          <span className="text-[#182533]">|</span>
          <span className="flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${ARB_TYPES.internal.dotClass}`} />
            <span className="text-[#FFFFFF] font-medium">Internal:</span>
            <span className="text-purple-400 font-mono font-semibold">{arbTypeCounts.internal}</span>
          </span>
        </div>
      )}

      {/* Filters */}
      <div className="rounded-xl border border-[#182533] bg-[#17212B] p-4 space-y-3">
        <div className="flex items-center gap-1.5 mb-1">
          <Filter className="w-4 h-4 text-[#8A9BA8]" />
          <span className="text-xs font-semibold text-[#8A9BA8] uppercase tracking-wide">Filters</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {/* Search */}
          <div className="md:col-span-2">
            <label className="block text-[10px] text-[#8A9BA8] mb-1">Search (market name, ID, or strategy)</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8A9BA8]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                className="w-full pl-8 pr-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] placeholder-[#8A9BA8] focus:outline-none focus:border-[#5DBE81]"
              />
            </div>
          </div>

          {/* Min ROI */}
          <div>
            <label className="block text-[10px] text-[#8A9BA8] mb-1">Min ROI %</label>
            <input
              type="number"
              step="0.1"
              value={minRoi}
              onChange={(e) => setMinRoi(e.target.value)}
              placeholder="0"
              className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] placeholder-[#8A9BA8] focus:outline-none focus:border-[#5DBE81]"
            />
          </div>

          {/* From Date */}
          <div>
            <label className="block text-[10px] text-[#8A9BA8] mb-1">From Date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
            />
          </div>

          {/* To Date */}
          <div>
            <label className="block text-[10px] text-[#8A9BA8] mb-1">To Date</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
            />
          </div>
        </div>

        {/* Date-range presets */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">Preset:</span>
          <div className="flex items-center gap-0.5 bg-[#0E1621] rounded-lg p-0.5 border border-[#182533]">
            {[
              { key: "today", label: "Today" },
              { key: "7d", label: "Last 7 days" },
              { key: "30d", label: "Last 30 days" },
              { key: "month", label: "Full month" },
            ].map((opt) => (
              <button
                key={opt.key}
                onClick={() => setDateRange(opt.key as any)}
                className="min-h-11 px-2.5 py-1 rounded text-[10px] font-medium transition-colors text-[#8A9BA8] hover:text-[#FFFFFF]"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Toggle + Event Type Filter */}
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex min-h-11 items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={positiveArbOnly}
              onChange={(e) => setPositiveArbOnly(e.target.checked)}
              className="w-4 h-4 accent-[#5DBE81] rounded"
            />
            <span className="text-xs text-[#8A9BA8]">Positive arb only</span>
          </label>
          {/* Event type filter pills */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">Type:</span>
            <div className="flex items-center gap-0.5 bg-[#0E1621] rounded-lg p-0.5 border border-[#182533]">
              {EVENT_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setEventType(opt.key)}
                  className={`min-h-11 px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                    eventType === opt.key
                      ? "bg-[#5DBE81]/20 text-[#5DBE81]"
                      : "text-[#8A9BA8] hover:text-[#FFFFFF]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {/* Arb type filter pills */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">Arb Type:</span>
            <div className="flex items-center gap-0.5 bg-[#0E1621] rounded-lg p-0.5 border border-[#182533]">
              {ARB_TYPE_FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setArbTypeFilter(opt.key)}
                  className={`min-h-11 px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                    arbTypeFilter === opt.key
                      ? opt.key === "direct"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : opt.key === "cross"
                        ? "bg-blue-500/20 text-blue-400"
                        : opt.key === "internal"
                        ? "bg-purple-500/20 text-purple-400"
                        : "bg-[#5DBE81]/20 text-[#5DBE81]"
                      : "text-[#8A9BA8] hover:text-[#FFFFFF]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-[#ef4444]">
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-sm text-[#8A9BA8]">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
            Loading logs...
          </div>
        ) : sorted.length === 0 ? (
          <div className="py-16 text-center text-sm text-[#8A9BA8]">
            <FileText className="w-6 h-6 mx-auto mb-2 opacity-40" />
            No log entries. Run a scan to generate data.
          </div>
        ) : (
          <div className="overflow-x-auto" data-testid="logs-table-scroll">
            <table className="w-full min-w-[1050px] text-sm">
              <thead>
                <tr className="border-b border-[#182533] bg-[#0E1621]">
                  <th className="sticky left-0 z-20 bg-[#0E1621] px-3 py-2.5 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    Category
                  </th>
                  <th
                    className="px-3 py-2.5 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("scanned_at")}
                  >
                    Scan Time {sortKey === "scanned_at" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />) : null}
                  </th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    Market Name
                  </th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    Strategy
                  </th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    Arb Type
                  </th>
                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("best_roi_pct")}
                  >
                    ROI % {sortKey === "best_roi_pct" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />) : null}
                  </th>
                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("best_profit")}
                  >
                    Profit {sortKey === "best_profit" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />) : null}
                  </th>
                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("apy")}
                  >
                    APY {sortKey === "apy" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />) : null}
                  </th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    TTE
                  </th>
                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("matched_count")}
                  >
                    Matched {sortKey === "matched_count" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />) : null}
                  </th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    K / PM
                  </th>
                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("positive_arb_count")}
                  >
                    Arbs {sortKey === "positive_arb_count" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />) : null}
                  </th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    Stake
                  </th>
                  <th className="px-3 py-2.5 text-center text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap w-10"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((log, i) => (
                  <LogRow key={log.id ?? i} log={log} expanded={expandedId === log.id} onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)} fmtPct={fmtPct} fmtUsd={fmtUsd} fmtTime={fmtTime} savedMarkets={savedMarkets} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Count + Load More */}
      {!loading && sorted.length > 0 && (
        <div className="flex items-center justify-between">
          <div className="text-xs text-[#A8B8C4]">
            Showing {sorted.length} of {logs.length} entries
          </div>
          {nextCursor && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="px-3 py-1.5 rounded-lg bg-[#182533] border border-[#232E3C] text-xs font-medium text-[#A8B8C4] hover:text-[#FFFFFF] hover:border-[#5DBE81]/30 transition-colors disabled:opacity-50"
            >
              {loadingMore ? "Loading..." : "Load More"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function logApyPct(log: LogEntry): number | null {
  if (!log.raw_result) return null;
  try {
    const arbs = JSON.parse(log.raw_result)?.allArbs ?? [];
    const values = arbs.map((arb: any) => Number(arb?.apyPct)).filter((value: number) => Number.isFinite(value) && value > 0);
    return values.length ? Math.max(...values) : null;
  } catch {
    return null;
  }
}

type ClientCurrentQuote = {
  platform: QuotePlatform;
  marketId: string;
  outcome: QuoteOutcome;
  status: 'available' | 'unavailable' | 'closed' | 'resolved' | 'error';
  priceNow: number | null;
  source: string;
  quotedAt: string;
  stale: boolean;
};

type ComparisonCache = Map<string, { quotes: ClientCurrentQuote[]; fetchedAt: number }>;

function LogRow({
  log,
  expanded,
  onToggle,
  fmtPct,
  fmtUsd,
  fmtTime,
  savedMarkets,
}: {
  log: LogEntry;
  expanded: boolean;
  onToggle: () => void;
  fmtPct: (n: number) => string;
  fmtUsd: (n: number) => string;
  fmtTime: (s: string) => string;
  savedMarkets: Map<string, { title: string; expiryDate?: string | null }>;
}) {
  const roiColor = log.best_roi_pct > 0 ? "text-[#5DBE81]" : log.best_roi_pct < 0 ? "text-[#ef4444]" : "text-[#FFFFFF]";
  const arbBadge = log.positive_arb_count > 0 ? "bg-[#5DBE81]/10 text-[#5DBE81]" : "text-[#8A9BA8]";
  const arbTypeMeta = getArbTypeMeta(log.strategy);
  const apy = logApyPct(log);
  // Kept at row scope so collapsing does not discard the brief lazy-fetch cache.
  const [comparisonCache] = useState<ComparisonCache>(() => new Map());

  const savedMarket = savedMarkets.get(log.market_id);
  const marketName = log.market_name ?? log.market_title ?? savedMarket?.title;
  const expiry = savedMarket?.expiryDate ? new Date(savedMarket.expiryDate) : null;
  const minutesToExpiry = expiry ? Math.floor((expiry.getTime() - new Date(log.scanned_at).getTime()) / 60_000) : null;
  const tte = minutesToExpiry == null ? '—' : minutesToExpiry <= 0 ? 'Expired' : minutesToExpiry >= 1440 ? `${Math.floor(minutesToExpiry / 1440)}d ${Math.floor(minutesToExpiry % 1440 / 60)}h` : minutesToExpiry >= 60 ? `${Math.floor(minutesToExpiry / 60)}h ${minutesToExpiry % 60}m` : `${minutesToExpiry}m`;
  const hasMarketName = !!marketName;

  const handleNavigate = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.location.href = `/?view=scan&id=${encodeURIComponent(log.market_id)}`;
  };

  // Parse raw_result for expanded view
  let rawArbs: any[] = [];
  if (expanded && log.raw_result) {
    try {
      const parsed = JSON.parse(log.raw_result);
      rawArbs = parsed?.allArbs ?? parsed?.arbs ?? [];
    } catch {
      // ignore
    }
  }

  return (
    <>
      <tr
        className={`border-b border-[#182533] hover:bg-[#0E1621]/50 cursor-pointer transition-colors ${expanded ? "bg-[#0E1621]/50" : ""}`}
        onClick={onToggle}
      >
        <td className="sticky left-0 z-10 bg-[#17212B] px-3 py-2 text-xs text-[#8A9BA8] whitespace-nowrap truncate max-w-[120px]" title={log.category || undefined}>
          {log.category || "\u2014"}
        </td>
        <td className="px-3 py-2 text-xs text-[#8A9BA8] whitespace-nowrap font-mono">{fmtTime(log.scanned_at)}</td>
        <td className="px-3 py-2 text-xs truncate max-w-[180px]" title={log.market_id}>
          <span
            role="button"
            tabIndex={0}
            onClick={handleNavigate}
            onKeyDown={(e) => { if (e.key === "Enter") handleNavigate(e as unknown as React.MouseEvent); }}
            className={`cursor-pointer hover:underline ${hasMarketName ? "text-[#5DBE81]" : "text-[#8A9BA8]"}`}
          >
            {hasMarketName ? marketName : log.market_id}
          </span>
        </td>
        <td className="px-3 py-2 text-xs truncate max-w-[200px]" title={log.strategy}><CompactStrategyDisplay strategy={log.strategy} /></td>
        <td className="px-3 py-2 text-xs whitespace-nowrap">
          {arbTypeMeta ? (
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${arbTypeMeta.badgeClass}`}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${arbTypeMeta.dotClass}`} />
              {arbTypeMeta.label}
            </span>
          ) : (
            <span className="text-[#8A9BA8]">—</span>
          )}
        </td>
        <td className={`px-3 py-2 text-right text-xs font-mono font-semibold ${roiColor}`}>{fmtPct(log.best_roi_pct)}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#facc15]">{fmtUsd(log.best_profit)}</td>
        <td className={`px-3 py-2 text-right text-xs font-mono ${apy ? "text-[#5DBE81]" : "text-[#8A9BA8]"}`}>{apy ? fmtPct(apy) : "—"}</td>
        <td className={`px-3 py-2 text-right text-xs font-mono ${minutesToExpiry != null && minutesToExpiry <= 0 ? 'text-[#ef4444]' : 'text-[#8A9BA8]'}`}>{tte}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#FFFFFF]">{log.matched_count}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#8A9BA8]">{log.kalshi_count} / {log.pm_count}</td>
        <td className={`px-3 py-2 text-right text-xs font-mono ${arbBadge}`}>{log.positive_arb_count}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#8A9BA8]">{log.total_stake ? fmtUsd(log.total_stake) : "\u2014"}</td>
        <td className="px-3 py-2 text-center">
          <button
            onClick={handleNavigate}
            title="Open in Scan"
            className="p-1 rounded text-[#8A9BA8] hover:text-[#5DBE81] transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[#182533] bg-[#0E1621]">
          <td colSpan={12} className="px-4 py-3">
            {rawArbs.length > 0 ? (
              <div className="space-y-2">
                <div className="text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide mb-2">Arbitrage Opportunities ({rawArbs.length})</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {rawArbs.map((arb: any, i: number) => (
                    <div key={i} className="rounded-lg border border-[#182533] bg-[#17212B] p-3 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-[#FFFFFF]">{arb.artist || arb.strategy || "\u2014"}</span>
                        <div className="flex items-center gap-2">
                          {(() => {
                            const meta = getArbTypeMeta(arb.strategy);
                            return meta ? (
                              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${meta.badgeClass}`}>
                                <span className={`inline-block w-1.5 h-1.5 rounded-full ${meta.dotClass}`} />
                                {meta.label}
                              </span>
                            ) : null;
                          })()}
                          <span className={`text-xs font-mono font-semibold ${arb.roiPct > 0 ? "text-[#5DBE81]" : "text-[#ef4444]"}`}>
                            {fmtPct(arb.roiPct)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-[#8A9BA8]">
                        <span>Profit: <span className="text-[#facc15] font-mono">{fmtUsd(arb.expectedProfit)}</span></span>
                        <span>{arb.strategy}</span>
                      </div>
                      <HistoricalCurrentPriceComparison arb={arb} cache={comparisonCache} />
                      {arb.fees && (
                        <div className="text-[10px] text-[#8A9BA8] mt-1 pt-1 border-t border-[#182533]">
                          Fees — <img src="/kalshi-icon.png" alt="Kalshi" className="inline w-3 h-3 rounded-sm" /> {fmtUsd(arb.fees.kalshiFee ?? 0)} · <img src="/polymarket-icon.png" alt="Polymarket" className="inline w-3 h-3 rounded-sm" /> {fmtUsd(arb.fees.pmFee ?? 0)} · Net: {fmtUsd(arb.fees.worstCaseNetProfit ?? arb.fees.netProfitIfKalshiWins ?? 0)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-xs text-[#8A9BA8]">No detailed arb data available for this scan.</div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function HistoricalCurrentPriceComparison({
  arb,
  cache,
}: {
  arb: Record<string, unknown>;
  cache: ComparisonCache;
}) {
  const legs = useMemo(() => buildHistoricalLegs(arb), [arb]);
  const cacheKey = legs.map((leg) => `${leg.platform}:${leg.marketId ?? 'missing'}:${leg.outcome}`).join('|');
  const cached = cache.get(cacheKey);
  const identityMissing = legs.some((leg) => !leg.marketId);
  const [quotes, setQuotes] = useState<ClientCurrentQuote[] | null>(cached?.quotes ?? null);
  const [fetchState, setFetchState] = useState<'loading' | 'ready' | 'error' | 'rate-limited'>(
    cached ? 'ready' : identityMissing ? 'error' : 'loading',
  );

  useEffect(() => {
    const currentCached = cache.get(cacheKey);
    if (currentCached && Date.now() - currentCached.fetchedAt <= 30_000) return;
    if (identityMissing) return;

    let cancelled = false;
    void fetch('/api/logs/current-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        legs: legs.map(({ platform, marketId, outcome }) => ({ platform, marketId, outcome })),
      }),
    }).then(async (response) => {
      if (!response.ok) {
        if (response.status === 429) {
          if (!cancelled) setFetchState('rate-limited');
          return;
        }
        throw new Error('Current quote request failed');
      }
      const data = await response.json();
      if (!Array.isArray(data?.quotes) || data.quotes.length !== 2) throw new Error('Invalid current quote response');
      const nextQuotes = data.quotes as ClientCurrentQuote[];
      cache.set(cacheKey, { quotes: nextQuotes, fetchedAt: Date.now() });
      if (!cancelled) {
        setQuotes(nextQuotes);
        setFetchState('ready');
      }
    }).catch(() => {
      if (!cancelled) setFetchState('error');
    });
    return () => { cancelled = true; };
  }, [cache, cacheKey, identityMissing, legs]);

  if (fetchState === 'loading') {
    return <div className="mt-2 border-t border-[#182533] pt-2 text-[10px] text-[#8A9BA8]">Loading current executable prices…</div>;
  }
  if (fetchState === 'rate-limited') {
    return <div className="mt-2 border-t border-[#182533] pt-2 text-[10px] text-amber-400">Rate limited — current prices unavailable.</div>;
  }

  return (
    <div className="mt-2 space-y-1.5 border-t border-[#182533] pt-2" aria-label="Historical versus current executable prices">
      {legs.map((leg) => (
        <PriceComparisonLeg
          key={`${leg.platform}:${leg.outcome}`}
          historical={leg}
          current={quotes?.find((quote) => quote.platform === leg.platform && quote.outcome === leg.outcome) ?? null}
          requestFailed={fetchState === 'error'}
        />
      ))}
    </div>
  );
}

const quoteCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function formatQuotePrice(price: number | null): string {
  return price == null ? 'Unavailable' : quoteCurrency.format(price);
}

function currentStatusText(quote: ClientCurrentQuote | null, requestFailed: boolean): string {
  if (requestFailed) return 'Quote fetch failed';
  if (!quote) return 'Unavailable';
  if (quote.status === 'resolved') return 'Resolved market';
  if (quote.status === 'closed') return 'Closed market';
  if (quote.status === 'error') return 'Quote fetch failed';
  if (quote.status === 'unavailable' || quote.priceNow == null) return 'Unavailable';
  return formatQuotePrice(quote.priceNow);
}

function PriceComparisonLeg({
  historical,
  current,
  requestFailed,
}: {
  historical: HistoricalPriceLeg;
  current: ClientCurrentQuote | null;
  requestFailed: boolean;
}) {
  const change = calculatePriceChange(historical.priceThen, current?.status === 'available' ? current.priceNow : null);
  const directionClass = change?.direction === 'up'
    ? 'text-[#5DBE81]'
    : change?.direction === 'down'
      ? 'text-[#ef4444]'
      : 'text-[#A8B8C4]';
  const sign = change ? (change.direction === 'up' ? '+' : change.direction === 'down' ? '−' : '') : '';
  const changeText = change
    ? `${sign}${quoteCurrency.format(Math.abs(change.absolute))} (${sign}${Math.abs(change.percentage).toFixed(2)}%)`
    : 'Unavailable';
  const platformName = historical.platform === 'kalshi' ? 'Kalshi' : 'Polymarket';
  const freshness = current?.quotedAt
    ? new Date(current.quotedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className="grid grid-cols-[minmax(100px,1.15fr)_repeat(3,minmax(72px,1fr))] items-center gap-2 rounded bg-[#0E1621] px-2 py-1.5 text-[10px]">
      <div className="min-w-0">
        <div className="flex items-center gap-1 font-semibold text-[#FFFFFF]">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${historical.platform === 'kalshi' ? 'bg-sky-400' : 'bg-violet-400'}`} />
          {platformName} {historical.outcome.toUpperCase()}
        </div>
        <div className="truncate font-mono text-[9px] text-[#8A9BA8]" title={historical.marketId ?? undefined}>{historical.marketId ?? 'Identifier missing'}</div>
      </div>
      <div>
        <div className="text-[9px] uppercase tracking-wide text-[#8A9BA8]">Price then</div>
        <div className="font-mono font-semibold text-[#FFFFFF]">{formatQuotePrice(historical.priceThen)}</div>
      </div>
      <div>
        <div className="text-[9px] uppercase tracking-wide text-[#8A9BA8]">Price now</div>
        <div className="font-mono font-semibold text-[#FFFFFF]">{currentStatusText(current, requestFailed)}</div>
        {current?.stale ? <div className="font-semibold text-amber-400">Stale quote</div> : null}
      </div>
      <div>
        <div className="text-[9px] uppercase tracking-wide text-[#8A9BA8]">Change</div>
        <div className={`font-mono font-semibold ${directionClass}`}>{changeText}</div>
        {current?.status === 'available' && (
          <div className="text-[9px] text-[#8A9BA8]">{current.source}{freshness ? ` · ${freshness}` : ''}</div>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border border-[#182533] bg-[#17212B] p-2.5">
      <div className="text-[10px] text-[#8A9BA8] mb-0.5">{label}</div>
      <div className="text-sm font-bold" style={{ color: color || "#FFFFFF" }}>
        {value}
      </div>
    </div>
  );
}