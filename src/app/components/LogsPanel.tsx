"use client";

import {
  FileText,
  Download,
  Filter,
  RefreshCw,
  ChevronUp,
  ChevronDown,
  Search,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { getArbTypeMeta, ARB_TYPES, type ArbType } from "@/lib/arb-types";
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
  expiry_at: string | null;
  days_to_expiry: number | null;
  apy_pct: number | null;
  apy_unavailable_reason: string | null;
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

const LOG_ROW_HEIGHT = 37;
const LOG_RENDER_WINDOW = 100;

export default function LogsPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [savedMarkets, setSavedMarkets] = useState<Map<string, { title: string; expiryDate?: string | null }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [minRoi, setMinRoi] = useState("");
  const [positiveArbOnly, setPositiveArbOnly] = useState(true);
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 86_400_000).toISOString());
  const [toDate, setToDate] = useState(() => new Date().toISOString());
  const [eventType, setEventType] = useState<EventType>("all");
  const [arbTypeFilter, setArbTypeFilter] = useState<ArbTypeFilter>("all");
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("scanned_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [tableScrollTop, setTableScrollTop] = useState(0);

  // Expand row
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<{ totalArbs: number; avgRoi: number; bestRoi: number; totalProfit: number; arbTypeCounts: { direct: number; cross: number; internal: number } } | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestGeneration = useRef(0);
  const loadingMoreGeneration = useRef<number | null>(null);

  // UI-034: unique markets count from SQL COUNT(DISTINCT market_id)
  const [uniqueMarkets, setUniqueMarkets] = useState<number | null>(null);

  // UI-035: export row count estimate
  const [exportCount, setExportCount] = useState<number | null>(null);
  const [exportCountLoading, setExportCountLoading] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const updateSearchQuery = useCallback((value: string) => {
    // Invalidate an in-flight append in the input event, before debounce starts
    // the replacement query. This also clears the visible append state without
    // a synchronous state update inside an effect.
    requestGeneration.current += 1;
    loadingMoreGeneration.current = null;
    setLoadingMore(false);
    setSearchQuery(value);
  }, []);

  const buildParams = useCallback((before?: string) => {
    const params = new URLSearchParams();
    params.set("limit", "250");
    if (before) params.set("before", before);
    if (minRoi) params.set("minRoi", minRoi);
    if (positiveArbOnly) params.set("positiveArbOnly", "true");
    if (fromDate) params.set("fromDate", fromDate);
    if (toDate) params.set("toDate", toDate);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (eventType !== "all") params.set("eventType", eventType);
    if (arbTypeFilter !== "all") params.set("arbType", arbTypeFilter);
    return params;
  }, [minRoi, positiveArbOnly, fromDate, toDate, debouncedSearch, eventType, arbTypeFilter]);

  const fetchLogs = useCallback(async () => {
    const generation = ++requestGeneration.current;
    loadingMoreGeneration.current = null;
    setLoadingMore(false);
    setLoading(true);
    setError("");
    setLoadMoreError("");
    setNextCursor(undefined);
    try {
      const params = buildParams();
      const res = await fetch(`/api/logs?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (generation !== requestGeneration.current) return;
      if (res.ok === false) throw new Error(data.error || "Failed to fetch logs");
      if (data.error) {
        setError(data.error);
      } else {
        setLogs(data.logs || []);
        setNextCursor((data.logs || []).length >= data.total ? undefined : data.nextCursor);
        setUniqueMarkets(typeof data.uniqueMarkets === "number" ? data.uniqueMarkets : null);
        setTotal(typeof data.total === "number" ? data.total : (data.logs || []).length);
        setSummary(data.summary ?? null);
      }
    } catch (e: unknown) {
      if (generation === requestGeneration.current) setError((e instanceof Error ? e.message : String(e)) || "Failed to fetch logs");
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [buildParams]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreGeneration.current !== null) return;
    const generation = requestGeneration.current;
    loadingMoreGeneration.current = generation;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const params = buildParams(nextCursor);
      const res = await fetch(`/api/logs?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (generation !== requestGeneration.current) return;
      if (res.ok === false) throw new Error(data.error || "Failed to load more logs");
      if (data.error) {
        setLoadMoreError(data.error);
      } else {
        setLogs(prev => {
          const ids = new Set(prev.map((row) => row.id));
          const combined = [...prev, ...(data.logs || []).filter((row: LogEntry) => !ids.has(row.id))];
          setNextCursor(combined.length >= data.total ? undefined : data.nextCursor);
          return combined;
        });
      }
    } catch (e: unknown) {
      if (generation === requestGeneration.current) setLoadMoreError((e instanceof Error ? e.message : String(e)) || "Failed to load more logs");
    } finally {
      if (loadingMoreGeneration.current === generation) {
        loadingMoreGeneration.current = null;
        if (generation === requestGeneration.current) setLoadingMore(false);
      }
    }
  }, [nextCursor, buildParams]);

  useEffect(() => {
    const run = async () => { await fetchLogs(); };
    void run();
  }, [fetchLogs]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "600px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

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

  // Sort
  const sorted = useMemo(() => {
    const arr = [...logs];
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
  }, [logs, sortKey, sortDir]);

  const visibleWindow = useMemo(() => {
    const maxStart = Math.max(0, sorted.length - LOG_RENDER_WINDOW);
    const start = Math.min(Math.max(0, Math.floor(tableScrollTop / LOG_ROW_HEIGHT) - 10), maxStart);
    const end = Math.min(sorted.length, start + LOG_RENDER_WINDOW);
    return { start, end, rows: sorted.slice(start, end) };
  }, [sorted, tableScrollTop]);


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
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (eventType !== "all") params.set("eventType", eventType);
    if (arbTypeFilter !== "all") params.set("arbType", arbTypeFilter);
    return `/api/logs/export?${params.toString()}`;
  }, [minRoi, positiveArbOnly, fromDate, toDate, debouncedSearch, eventType, arbTypeFilter]);
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

  // UI-046: the Today preset is a precise rolling 24-hour window.
  const setDateRange = useCallback((preset: "today" | "7d" | "30d" | "month") => {
    const now = new Date();
    let from: Date;
    let to: Date = now;
    switch (preset) {
      case "today":
        from = new Date(now.getTime() - 86_400_000);
        break;
      case "7d":
        from = new Date(now.getTime() - 7 * 86_400_000);
        break;
      case "30d":
        from = new Date(now.getTime() - 30 * 86_400_000);
        break;
      case "month":
        from = new Date(now.getFullYear(), now.getMonth(), 1);
        to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        break;
    }
    setFromDate(from.toISOString());
    setToDate(to.toISOString());
  }, []);


  const exportEstimateText = useMemo(() => {
    if (exportCountLoading) return "Estimating export size...";
    if (exportCount === null) return "";
    return `This will export ${exportCount.toLocaleString()} row${exportCount === 1 ? "" : "s"}`;
  }, [exportCount, exportCountLoading]);

  const arbTypeCounts = summary?.arbTypeCounts ?? { direct: 0, cross: 0, internal: 0 };

  // Stats summary
  const stats = summary ? { ...summary, count: total } : null;

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
            <label htmlFor="logs-search" className="block text-[10px] text-[#8A9BA8] mb-1">Search (market name, ID, or strategy)</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8A9BA8]" />
              <input
                id="logs-search"
                type="text"
                value={searchQuery}
                onChange={(e) => updateSearchQuery(e.target.value)}
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
              type="datetime-local"
              value={fromDate.slice(0, 16)}
              onChange={(e) => setFromDate(e.target.value ? new Date(e.target.value).toISOString() : "")}
              className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
            />
          </div>

          {/* To Date */}
          <div>
            <label className="block text-[10px] text-[#8A9BA8] mb-1">To Date</label>
            <input
              type="datetime-local"
              value={toDate.slice(0, 16)}
              onChange={(e) => setToDate(e.target.value ? new Date(e.target.value).toISOString() : "")}
              className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
            />
          </div>
        </div>

        {/* Date-range presets */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">Preset:</span>
          <div className="flex items-center gap-0.5 bg-[#0E1621] rounded-lg p-0.5 border border-[#182533]">
            {[
              { key: "today", label: "Latest 24 hours" },
              { key: "7d", label: "Last 7 days" },
              { key: "30d", label: "Last 30 days" },
              { key: "month", label: "Full month" },
            ].map((opt) => (
              <button
                key={opt.key}
                title={opt.key === "today" ? "Latest rolling 24 hours ending now" : undefined}
                onClick={() => setDateRange(opt.key as "today" | "7d" | "30d" | "month")}
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
          <div
            className="max-h-[70vh] overflow-x-auto overflow-y-auto"
            data-testid="logs-table-scroll"
            onScroll={(event) => setTableScrollTop(event.currentTarget.scrollTop)}
          >
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
                {visibleWindow.start > 0 && (
                  <tr aria-hidden="true"><td colSpan={14} style={{ height: visibleWindow.start * LOG_ROW_HEIGHT, padding: 0 }} /></tr>
                )}
                {visibleWindow.rows.map((log, i) => (
                  <LogRow key={log.id ?? i} log={log} expanded={expandedId === log.id} onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)} fmtPct={fmtPct} fmtUsd={fmtUsd} fmtTime={fmtTime} savedMarkets={savedMarkets} />
                ))}
                {visibleWindow.end < sorted.length && (
                  <tr aria-hidden="true"><td colSpan={14} style={{ height: (sorted.length - visibleWindow.end) * LOG_ROW_HEIGHT, padding: 0 }} /></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Count + infinite-scroll status */}
      {!loading && sorted.length > 0 && (
        <div className="flex flex-col items-center gap-2" aria-live="polite">
          <div className="text-xs text-[#A8B8C4]">
            Loaded {sorted.length.toLocaleString()} of {total.toLocaleString()} entries
          </div>
          <div ref={sentinelRef} className="h-px w-full" aria-hidden="true" />
          {loadingMore && <div className="text-xs text-[#8A9BA8]">Loading more results…</div>}
          {loadMoreError && (
            <div className="flex items-center gap-2 text-xs text-[#ef4444]">
              <span>{loadMoreError}</span>
            <button
              onClick={loadMore}
              className="px-3 py-1.5 rounded-lg bg-[#182533] border border-[#232E3C] text-xs font-medium text-[#A8B8C4] hover:text-[#FFFFFF] hover:border-[#5DBE81]/30 transition-colors disabled:opacity-50"
            >
              Retry
            </button>
            </div>
          )}
          {!nextCursor && !loadingMore && !loadMoreError && <div className="text-xs text-[#8A9BA8]">End of results</div>}
        </div>
      )}
    </div>
  );
}

function logApyPct(log: LogEntry): number | null {
  return typeof log.apy_pct === 'number' && Number.isFinite(log.apy_pct) ? log.apy_pct : null;
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
  const legacyExpiry = savedMarket?.expiryDate ? Date.parse(savedMarket.expiryDate) : Number.NaN;
  const legacyScan = Date.parse(log.scanned_at);
  const minutesToExpiry = typeof log.days_to_expiry === 'number' && Number.isFinite(log.days_to_expiry)
    ? Math.floor(log.days_to_expiry * 1440)
    : Number.isFinite(legacyExpiry) && Number.isFinite(legacyScan)
      ? Math.floor((legacyExpiry - legacyScan) / 60_000)
      : null;
  const tte = minutesToExpiry == null ? '—' : minutesToExpiry <= 0 ? 'Expired' : minutesToExpiry >= 1440 ? `${Math.floor(minutesToExpiry / 1440)}d ${Math.floor(minutesToExpiry % 1440 / 60)}h` : minutesToExpiry >= 60 ? `${Math.floor(minutesToExpiry / 60)}h ${minutesToExpiry % 60}m` : `${minutesToExpiry}m`;
  const hasMarketName = !!marketName;

  const handleNavigate = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.location.href = `/?view=scan&id=${encodeURIComponent(log.market_id)}`;
  };

  // Parse raw_result for expanded view
  let rawArbs: unknown[] = [];
  if (expanded && log.raw_result) {
    try {
      const parsed = JSON.parse(log.raw_result) as { allArbs?: unknown[]; arbs?: unknown[] } | null;
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
        <td
          className={`px-3 py-2 text-right text-xs font-mono ${apy != null ? "text-[#5DBE81]" : "text-[#8A9BA8]"}`}
          title={apy == null ? `APY unavailable: ${log.apy_unavailable_reason ?? 'unknown reason'}` : 'APY captured at scan time'}
        >{apy != null ? fmtPct(apy) : "Unavailable"}</td>
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
          <td colSpan={14} className="px-4 py-3">
            {rawArbs.length > 0 ? (
              <div className="space-y-2">
                <div className="text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide mb-2">Arbitrage Opportunities ({rawArbs.length})</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {rawArbs.map((rawArb, i) => {
                    const arb = rawArb as Record<string, unknown>;
                    const arbFees = (arb.fees ?? {}) as Record<string, unknown>;
                    return (
                    <div key={i} className="rounded-lg border border-[#182533] bg-[#17212B] p-3 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-[#FFFFFF]">{String(arb.artist || arb.strategy || "—")}</span>
                        <div className="flex items-center gap-2">
                          {(() => {
                            const meta = getArbTypeMeta(String(arb.strategy));
                            return meta ? (
                              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${meta.badgeClass}`}>
                                <span className={`inline-block w-1.5 h-1.5 rounded-full ${meta.dotClass}`} />
                                {meta.label}
                              </span>
                            ) : null;
                          })()}
                          <span className={`text-xs font-mono font-semibold ${Number(arb.roiPct) > 0 ? "text-[#5DBE81]" : "text-[#ef4444]"}`}>
                            {fmtPct(Number(arb.roiPct))}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-[#8A9BA8]">
                        <span>Profit: <span className="text-[#facc15] font-mono">{fmtUsd(Number(arb.expectedProfit))}</span></span>
                        <span>{String(arb.strategy)}</span>
                      </div>
                      <HistoricalCurrentPriceComparison arb={arb} cache={comparisonCache} />
                      {arb.fees && (
                        <div className="text-[10px] text-[#8A9BA8] mt-1 pt-1 border-t border-[#182533]">
                          Fees — <img src="/kalshi-icon.png" alt="Kalshi" className="inline w-3 h-3 rounded-sm" /> {fmtUsd(Number(arbFees.kalshiFee ?? 0))} · <img src="/polymarket-icon.png" alt="Polymarket" className="inline w-3 h-3 rounded-sm" /> {fmtUsd(Number(arbFees.pmFee ?? 0))} · Net: {fmtUsd(Number(arbFees.worstCaseNetProfit ?? arbFees.netProfitIfKalshiWins ?? 0))}
                        </div>
                      )}
                    </div>
                    );
                  })}
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