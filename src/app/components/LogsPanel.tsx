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

type SortKey = "scanned_at" | "best_roi_pct" | "best_profit" | "positive_arb_count" | "matched_count";
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
      }
    } catch (e: any) {
      setError(e.message || "Failed to load more logs");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, minRoi, positiveArbOnly, fromDate, toDate]);

  useEffect(() => {
    fetchLogs();
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
        case "positive_arb_count":
          aVal = a.positive_arb_count;
          bVal = b.positive_arb_count;
          break;
        case "matched_count":
          aVal = a.matched_count;
          bVal = b.matched_count;
          break;
      }
      const sa = String(aVal);
      const sb = String(bVal);
      if (sortKey === "scanned_at") {
        return sortDir === "asc" ? Number(aVal) - Number(bVal) : Number(bVal) - Number(aVal);
      }
      return sortDir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
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

  const SortIcon = ({ col }: { col: SortKey }) =>
    sortKey === col ? (
      sortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />
    ) : null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <FileText className="w-5 h-5 text-[#5DBE81]" />
          Logs
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#182533] text-[#8A9BA8] hover:bg-[#232E3C] hover:text-[#FFFFFF] text-xs font-medium transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <a
            href={exportUrl}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#5DBE81] text-black font-semibold text-xs hover:bg-[#4DA66E] transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </a>
        </div>
      </div>

      {/* Stats Summary */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <StatBox label="Total Scans" value={stats.count.toString()} />
          <StatBox label="Total Arbs" value={stats.totalArbs.toString()} color="#5DBE81" />
          <StatBox label="Avg ROI" value={fmtPct(stats.avgRoi)} color={stats.avgRoi > 0 ? "#5DBE81" : "#ef4444"} />
          <StatBox label="Best ROI" value={fmtPct(stats.bestRoi)} color="#5DBE81" />
          <StatBox label="Total Profit" value={fmtUsd(stats.totalProfit)} color="#facc15" />
        </div>
      )}

      {/* Arb Type Summary */}
      {logs.length > 0 && (
        <div className="flex items-center gap-3 text-xs">
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

        {/* Toggle + Event Type Filter */}
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer">
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
                  className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
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
                  className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#182533] bg-[#0E1621]">
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    Category
                  </th>
                  <th
                    className="px-3 py-2.5 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("scanned_at")}
                  >
                    Scan Time <SortIcon col="scanned_at" />
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
                    ROI % <SortIcon col="best_roi_pct" />
                  </th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    APY
                  </th>
                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("best_profit")}
                  >
                    Profit <SortIcon col="best_profit" />
                  </th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    TTE
                  </th>
                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("matched_count")}
                  >
                    Matched <SortIcon col="matched_count" />
                  </th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    K / PM
                  </th>
                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("positive_arb_count")}
                  >
                    Arbs <SortIcon col="positive_arb_count" />
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
        <td className="px-3 py-2 text-xs text-[#8A9BA8] whitespace-nowrap truncate max-w-[120px]" title={log.category || undefined}>
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
        <td className={`px-3 py-2 text-right text-xs font-mono ${apy ? "text-[#5DBE81]" : "text-[#8A9BA8]"}`}>{apy ? fmtPct(apy) : "—"}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#facc15]">{fmtUsd(log.best_profit)}</td>
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