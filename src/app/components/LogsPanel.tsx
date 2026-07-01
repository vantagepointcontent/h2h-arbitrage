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
}

type EventType = "all" | "scan" | "arb" | "system";

const EVENT_TYPE_OPTIONS: { key: EventType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "scan", label: "Scan" },
  { key: "arb", label: "Arb" },
  { key: "system", label: "System" },
];

type SortKey = "scanned_at" | "best_roi_pct" | "best_profit" | "positive_arb_count" | "matched_count";
type SortDir = "asc" | "desc";

export function LogsPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [savedMarkets, setSavedMarkets] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [minRoi, setMinRoi] = useState("");
  const [positiveArbOnly, setPositiveArbOnly] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [eventType, setEventType] = useState<EventType>("all");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const lastLogCountRef = useRef(0);

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("scanned_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Expand row
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("limit", "500");
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
      }
    } catch (e: any) {
      setError(e.message || "Failed to fetch logs");
    } finally {
      setLoading(false);
    }
  }, [minRoi, positiveArbOnly, fromDate, toDate]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Auto-refresh: poll every 15s for real-time log streaming
  useEffect(() => {
    if (!autoRefresh) return;
    const iv = setInterval(fetchLogs, 15000);
    return () => clearInterval(iv);
  }, [autoRefresh, fetchLogs]);

  // Fetch saved markets for market name lookup
  useEffect(() => {
    fetch("/api/saved-markets?fields=basic")
      .then((res) => res.json())
      .then((data) => {
        const m = new Map<string, string>();
        const list = Array.isArray(data) ? data : (data?.markets ?? []);
        for (const mk of list) {
          if (mk.eventTitle) m.set(mk.id, mk.eventTitle);
        }
        setSavedMarkets(m);
      })
      .catch(() => {});
  }, []);

  // Filter by search query (market_id, market name, or strategy) + event type
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
    
    if (!searchQuery.trim()) return result;
    const q = searchQuery.toLowerCase();
    return result.filter(
      (l) => {
        const marketName = savedMarkets.get(l.market_id);
        return (
          l.market_id?.toLowerCase().includes(q) ||
          marketName?.toLowerCase().includes(q) ||
          l.strategy?.toLowerCase().includes(q)
        );
      }
    );
  }, [logs, searchQuery, savedMarkets, eventType]);

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

      {/* Filters */}
      <div className="rounded-xl border border-[#182533] bg-[#17212B] p-4 space-y-3">
        <div className="flex items-center gap-1.5 mb-1">
          <Filter className="w-4 h-4 text-[#5E6875]" />
          <span className="text-xs font-semibold text-[#8A9BA8] uppercase tracking-wide">Filters</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {/* Search */}
          <div className="md:col-span-2">
            <label className="block text-[10px] text-[#5E6875] mb-1">Search (market name, ID, or strategy)</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#5E6875]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                className="w-full pl-8 pr-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] placeholder-[#5E6875] focus:outline-none focus:border-[#5DBE81]"
              />
            </div>
          </div>

          {/* Min ROI */}
          <div>
            <label className="block text-[10px] text-[#5E6875] mb-1">Min ROI %</label>
            <input
              type="number"
              step="0.1"
              value={minRoi}
              onChange={(e) => setMinRoi(e.target.value)}
              placeholder="0"
              className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] placeholder-[#5E6875] focus:outline-none focus:border-[#5DBE81]"
            />
          </div>

          {/* From Date */}
          <div>
            <label className="block text-[10px] text-[#5E6875] mb-1">From Date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
            />
          </div>

          {/* To Date */}
          <div>
            <label className="block text-[10px] text-[#5E6875] mb-1">To Date</label>
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
            <span className="text-[10px] text-[#5E6875] uppercase tracking-wide">Type:</span>
            <div className="flex items-center gap-0.5 bg-[#0E1621] rounded-lg p-0.5 border border-[#182533]">
              {EVENT_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setEventType(opt.key)}
                  className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                    eventType === opt.key
                      ? "bg-[#5DBE81]/20 text-[#5DBE81]"
                      : "text-[#5E6875] hover:text-[#FFFFFF]"
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
          <div className="py-16 text-center text-sm text-[#5E6875]">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
            Loading logs...
          </div>
        ) : sorted.length === 0 ? (
          <div className="py-16 text-center text-sm text-[#5E6875]">
            <FileText className="w-6 h-6 mx-auto mb-2 opacity-40" />
            No log entries. Run a scan to generate data.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#182533] bg-[#0E1621]">
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
                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("best_roi_pct")}
                  >
                    ROI % <SortIcon col="best_roi_pct" />
                  </th>
                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("best_profit")}
                  >
                    Profit <SortIcon col="best_profit" />
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

      {/* Count */}
      {!loading && sorted.length > 0 && (
        <div className="text-xs text-[#5E6875] text-right">
          Showing {sorted.length} of {logs.length} entries
        </div>
      )}
    </div>
  );
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
  savedMarkets: Map<string, string>;
}) {
  const roiColor = log.best_roi_pct > 0 ? "text-[#5DBE81]" : log.best_roi_pct < 0 ? "text-[#ef4444]" : "text-[#FFFFFF]";
  const arbBadge = log.positive_arb_count > 0 ? "bg-[#5DBE81]/10 text-[#5DBE81]" : "text-[#5E6875]";

  const marketName = savedMarkets.get(log.market_id);
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
        <td className="px-3 py-2 text-xs text-[#8A9BA8] whitespace-nowrap font-mono">{fmtTime(log.scanned_at)}</td>
        <td className="px-3 py-2 text-xs truncate max-w-[180px]" title={log.market_id}>
          <span
            role="button"
            tabIndex={0}
            onClick={handleNavigate}
            onKeyDown={(e) => { if (e.key === "Enter") handleNavigate(e as unknown as React.MouseEvent); }}
            className={`cursor-pointer hover:underline ${hasMarketName ? "text-[#5DBE81]" : "text-[#5E6875]"}`}
          >
            {hasMarketName ? marketName : log.market_id}
          </span>
        </td>
        <td className="px-3 py-2 text-xs text-[#8A9BA8] truncate max-w-[200px]" title={log.strategy}>{log.strategy || "\u2014"}</td>
        <td className={`px-3 py-2 text-right text-xs font-mono font-semibold ${roiColor}`}>{fmtPct(log.best_roi_pct)}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#facc15]">{fmtUsd(log.best_profit)}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#FFFFFF]">{log.matched_count}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#5E6875]">{log.kalshi_count} / {log.pm_count}</td>
        <td className={`px-3 py-2 text-right text-xs font-mono ${arbBadge}`}>{log.positive_arb_count}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#5E6875]">{log.total_stake ? fmtUsd(log.total_stake) : "\u2014"}</td>
        <td className="px-3 py-2 text-center">
          <button
            onClick={handleNavigate}
            title="Open in Scan"
            className="p-1 rounded text-[#5E6875] hover:text-[#5DBE81] transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[#182533] bg-[#0E1621]">
          <td colSpan={10} className="px-4 py-3">
            {rawArbs.length > 0 ? (
              <div className="space-y-2">
                <div className="text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide mb-2">Arbitrage Opportunities ({rawArbs.length})</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {rawArbs.map((arb: any, i: number) => (
                    <div key={i} className="rounded-lg border border-[#182533] bg-[#17212B] p-3 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-[#FFFFFF]">{arb.artist || arb.strategy || "\u2014"}</span>
                        <span className={`text-xs font-mono font-semibold ${arb.roiPct > 0 ? "text-[#5DBE81]" : "text-[#ef4444]"}`}>
                          {fmtPct(arb.roiPct)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-[#5E6875]">
                        <span>Profit: <span className="text-[#facc15] font-mono">{fmtUsd(arb.expectedProfit)}</span></span>
                        <span>{arb.strategy}</span>
                      </div>
                      {arb.fees && (
                        <div className="text-[10px] text-[#5E6875] mt-1 pt-1 border-t border-[#182533]">
                          Fees — Kalshi: {fmtUsd(arb.fees.kalshiFee ?? 0)} · PM: {fmtUsd(arb.fees.pmFee ?? 0)} · Net: {fmtUsd(arb.fees.worstCaseNetProfit ?? arb.fees.netProfitIfKalshiWins ?? 0)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-xs text-[#5E6875]">No detailed arb data available for this scan.</div>
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
      <div className="text-[10px] text-[#5E6875] mb-0.5">{label}</div>
      <div className="text-sm font-bold" style={{ color: color || "#FFFFFF" }}>
        {value}
      </div>
    </div>
  );
}