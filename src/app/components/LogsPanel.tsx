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
  CircleHelp,
} from "lucide-react";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { projectCanonicalArbClassification, ARB_TYPES, type ArbType } from "@/lib/arb-types";
import { CompactStrategyDisplay } from "./ArbLegBreakdown";
import {
  buildHistoricalLegs,
  calculatePriceChange,
  type HistoricalPriceLeg,
  type QuoteOutcome,
  type QuotePlatform,
} from "@/lib/log-price-comparison";
import { compareRoiDecline } from "@/lib/roi-declined";
import { parseCalculationEnvelope } from "@/lib/calculation-envelope";
import { CalculationProvenance } from "./CalculationProvenance";
import { resolveHistoricalScanFinancials, type HistoricalScanFinancials } from "@/lib/historical-scan-financials";
import { SCAN_STATUS_HEADER_EXPLANATION, scanStatusPresentation, type ScanStatusTone } from "@/lib/scan-status";

interface LogEntry {
  id: number;
  market_id: string;
  best_roi_pct: number | null;
  best_profit: number | null;
  strategy: string;
  outcome_count: number;
  matched_count: number;
  kalshi_count: number;
  pm_count: number;
  positive_arb_count: number;
  total_stake: number | null;
  scanned_at: string;
  scan_status?: string | null;
  scan_status_reason?: string | null;

  market_title?: string | null;  // stored at scan time (BUG-030)
  market_name?: string | null;   // server-resolved (UI-015)
  category?: string | null;      // resolved from saved_markets (UI-015)
  expiry_at: string | null;
  days_to_expiry: number | null;
  apy_pct: number | null;
  apy_unavailable_reason: string | null;
  arb_type: ArbType | null;
  arb_valid: 0 | 1;
  arb_invalidation_reason: string | null;
  calculation_envelope?: unknown;
  historical_financials?: HistoricalScanFinancials;
  botTraderEvaluationCompleted?: boolean;
  botTraderEvaluationStatus?: BotTraderEvaluationStatus;
  botTraderEvaluation?: BotTraderEvaluation | null;
}

type BotTraderEvaluationStatus = 'pending' | 'completed' | 'partial' | 'failed' | 'not_run_disabled' | 'not_applicable_no_positive_arb';

interface BotTraderEvaluation {
  status: BotTraderEvaluationStatus;
  botTraderEvaluationCompleted: boolean;
  reason: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  candidateCount: number;
  evaluatedCount: number;
  eligibleCount: number;
  placementAttemptCount: number;
  placedCount: number;
  skippedCount: number;
  failureCount: number;
  missingCandidateIndexes: number[];
  failingCandidateIndexes: number[];
}

type ArbTypeFilter = "all" | ArbType;

const ARB_TYPE_FILTER_OPTIONS: { key: ArbTypeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "direct", label: "Direct" },
  { key: "cross", label: "Cross" },
  { key: "internal", label: "Internal" },
];

type EventType = "all" | "scan" | "arb" | "system";
type TteFilter = "all" | 30 | 90 | 180;

const EVENT_TYPE_OPTIONS: { key: EventType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "scan", label: "Scan" },
  { key: "arb", label: "Arb" },
  { key: "system", label: "System" },
];

const TTE_FILTER_OPTIONS: { key: TteFilter; label: string; ariaLabel: string }[] = [
  { key: 30, label: "<30d", ariaLabel: "TTE under 30 days" },
  { key: 90, label: "<90d", ariaLabel: "TTE under 90 days" },
  { key: 180, label: "<180d", ariaLabel: "TTE under 180 days" },
  { key: "all", label: "All", ariaLabel: "All TTE" },
];

type SortKey = "scanned_at" | "best_roi_pct" | "best_profit" | "apy" | "positive_arb_count" | "matched_count";
type SortDir = "asc" | "desc";

const LOG_ROW_HEIGHT = 37;
const LOG_RENDER_WINDOW = 100;
const CURRENT_ROI_BATCH_SIZE = 100;

type CurrentRoiStatus = 'loading' | 'available' | 'no_arbitrage' | 'never_scanned' | 'unavailable' | 'upstream_failure';
type CurrentRoiValuation = { status: CurrentRoiStatus; roiPct?: number; strategy?: string; scannedAt?: string; scanId?: number; reasonCode?: string; reason?: string };

function currentRoiStatusLabel(status: CurrentRoiStatus): string {
  switch (status) {
    case 'loading': return 'Loading…';
    case 'no_arbitrage': return 'No arbitrage';
    case 'never_scanned': return 'Never scanned';
    case 'unavailable': return 'Unavailable';
    case 'upstream_failure': return 'Unavailable / failed';
    case 'available': return 'Available';
  }
}

export default function LogsPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [savedMarkets, setSavedMarkets] = useState<Map<string, { title: string; expiryDate?: string | null }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [minRoi, setMinRoi] = useState(0);
  const [maxRoi, setMaxRoi] = useState(0);
  // Default to the full canonical scan population. Positive-arb-only is an
  // explicit operator filter; making it the default can hide every completed
  // scan during a legitimate zero-executable-arb window.
  const [positiveArbOnly, setPositiveArbOnly] = useState(false);
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 86_400_000).toISOString());
  const [toDate, setToDate] = useState(() => new Date().toISOString());
  const [eventType, setEventType] = useState<EventType>("all");
  const [arbTypeFilter, setArbTypeFilter] = useState<ArbTypeFilter>("all");
  const [tteFilter, setTteFilter] = useState<TteFilter>("all");
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
  const [dataQuality, setDataQuality] = useState<{ latest?: { state?: string; breaches?: Array<{ field: string; trigger: string; unavailablePct: number }> } | null } | null>(null);
  const requestGeneration = useRef(0);
  const loadingMoreGeneration = useRef<number | null>(null);
  const lastRequestedCursor = useRef<string | null>(null);
  const lastLoadScrollTop = useRef(-1);
  const tableScrollerRef = useRef<HTMLDivElement | null>(null);
  const [currentRoiById, setCurrentRoiById] = useState<Map<number, CurrentRoiValuation>>(() => new Map());
  const currentRoiRequested = useRef(new Set<number>());
  const currentRoiMounted = useRef(true);
  const currentRoiGeneration = useRef(0);

  useEffect(() => () => { currentRoiMounted.current = false; }, []);

  // UI-034: unique markets count from SQL COUNT(DISTINCT market_id)
  const [uniqueMarkets, setUniqueMarkets] = useState<number | null>(null);

  // UI-035: export row count estimate
  const [exportCount, setExportCount] = useState<number | null>(null);
  const [exportCountLoading, setExportCountLoading] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const invalidatePagination = useCallback(() => {
    requestGeneration.current += 1;
    loadingMoreGeneration.current = null;
    lastRequestedCursor.current = null;
    lastLoadScrollTop.current = -1;
    setLoadingMore(false);
    setLoadMoreError("");
    setTableScrollTop(0);
    if (tableScrollerRef.current) tableScrollerRef.current.scrollTop = 0;
  }, []);

  const updateSearchQuery = useCallback((value: string) => {
    invalidatePagination();
    setSearchQuery(value);
  }, [invalidatePagination]);

  const buildParams = useCallback((before?: string) => {
    const params = new URLSearchParams();
    params.set("limit", before ? "500" : "250");
    if (before) params.set("before", before);
    if (minRoi > 0) params.set("minRoi", String(minRoi));
    if (positiveArbOnly) params.set("positiveArbOnly", "true");
    if (fromDate) params.set("fromDate", fromDate);
    if (toDate) params.set("toDate", toDate);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (eventType !== "all") params.set("eventType", eventType);
    if (arbTypeFilter !== "all") params.set("arbType", arbTypeFilter);
    if (tteFilter !== "all") params.set("maxTteDays", String(tteFilter));
    return params;
  }, [minRoi, positiveArbOnly, fromDate, toDate, debouncedSearch, eventType, arbTypeFilter, tteFilter]);

  const fetchLogs = useCallback(async () => {
    const generation = ++requestGeneration.current;
    currentRoiGeneration.current += 1;
    currentRoiRequested.current.clear();
    setCurrentRoiById(new Map());
    loadingMoreGeneration.current = null;
    lastRequestedCursor.current = null;
    lastLoadScrollTop.current = -1;
    setTableScrollTop(0);
    if (tableScrollerRef.current) tableScrollerRef.current.scrollTop = 0;
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
        setDataQuality(data.dataQuality ?? null);
        const nextMaxRoi = typeof data.maxRoiWithoutMin === "number" && Number.isFinite(data.maxRoiWithoutMin)
          ? Math.max(0, data.maxRoiWithoutMin)
          : 0;
        setMaxRoi(nextMaxRoi);
        setMinRoi((current) => Math.min(current, nextMaxRoi));
      }
    } catch (e: unknown) {
      if (generation === requestGeneration.current) setError((e instanceof Error ? e.message : String(e)) || "Failed to fetch logs");
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [buildParams]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreGeneration.current !== null || lastRequestedCursor.current === nextCursor) return;
    const generation = requestGeneration.current;
    lastRequestedCursor.current = nextCursor;
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
        throw new Error(data.error);
      } else {
        setLogs(prev => {
          const ids = new Set(prev.map((row) => row.id));
          const combined = [...prev, ...(data.logs || []).filter((row: LogEntry) => !ids.has(row.id))];
          setNextCursor(combined.length >= data.total ? undefined : data.nextCursor);
          return combined;
        });
      }
    } catch (e: unknown) {
      if (generation === requestGeneration.current) {
        lastRequestedCursor.current = null;
        setLoadMoreError((e instanceof Error ? e.message : String(e)) || "Failed to load more logs");
      }
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
          {
            const aField = (a.historical_financials ?? resolveHistoricalScanFinancials(a)).fields.roiPct;
            const bField = (b.historical_financials ?? resolveHistoricalScanFinancials(b)).fields.roiPct;
            aVal = aField.status === 'available' ? aField.value : Number.NEGATIVE_INFINITY;
            bVal = bField.status === 'available' ? bField.value : Number.NEGATIVE_INFINITY;
          }
          break;
        case "best_profit":
          {
            const aField = (a.historical_financials ?? resolveHistoricalScanFinancials(a)).fields.profitUsd;
            const bField = (b.historical_financials ?? resolveHistoricalScanFinancials(b)).fields.profitUsd;
            aVal = aField.status === 'available' ? aField.value : Number.NEGATIVE_INFINITY;
            bVal = bField.status === 'available' ? bField.value : Number.NEGATIVE_INFINITY;
          }
          break;
        case "apy":
          {
            const aField = (a.historical_financials ?? resolveHistoricalScanFinancials(a)).fields.apyPct;
            const bField = (b.historical_financials ?? resolveHistoricalScanFinancials(b)).fields.apyPct;
            aVal = aField.status === 'available' ? aField.value : Number.NEGATIVE_INFINITY;
            bVal = bField.status === 'available' ? bField.value : Number.NEGATIVE_INFINITY;
          }
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

  useEffect(() => {
    const ids = visibleWindow.rows.map((row) => row.id).filter((id) => !currentRoiRequested.current.has(id));
    if (ids.length === 0) return;
    const generation = currentRoiGeneration.current;
    ids.forEach((id) => currentRoiRequested.current.add(id));
    setCurrentRoiById((current) => {
      const next = new Map(current);
      ids.forEach((id) => next.set(id, { status: 'loading' }));
      return next;
    });
    const batches = Array.from({ length: Math.ceil(ids.length / CURRENT_ROI_BATCH_SIZE) }, (_, index) => (
      ids.slice(index * CURRENT_ROI_BATCH_SIZE, (index + 1) * CURRENT_ROI_BATCH_SIZE)
    ));
    void (async () => {
      const pages: Array<Array<CurrentRoiValuation & { id: number }>> = [];
      for (const batch of batches) {
        const response = await fetch('/api/logs/current-roi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: batch }),
        });
        if (!response.ok) throw new Error('Current ROI request failed');
        const data = await response.json();
        if (!Array.isArray(data?.valuations)) throw new Error('Invalid current ROI response');
        pages.push(data.valuations as Array<CurrentRoiValuation & { id: number }>);
      }
      return pages;
    })().then((pages) => {
      if (!currentRoiMounted.current || generation !== currentRoiGeneration.current) return;
      setCurrentRoiById((current) => {
        const next = new Map(current);
        pages.flat().forEach(({ id, ...valuation }) => next.set(id, valuation));
        return next;
      });
    }).catch(() => {
      if (!currentRoiMounted.current || generation !== currentRoiGeneration.current) return;
      setCurrentRoiById((current) => {
        const next = new Map(current);
        ids.forEach((id) => next.set(id, { status: 'upstream_failure' }));
        return next;
      });
    });
  }, [visibleWindow.rows]);


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
    if (minRoi > 0) params.set("minRoi", String(minRoi));
    if (positiveArbOnly) params.set("positiveArbOnly", "true");
    if (fromDate) params.set("fromDate", fromDate);
    if (toDate) params.set("toDate", toDate);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (eventType !== "all") params.set("eventType", eventType);
    if (arbTypeFilter !== "all") params.set("arbType", arbTypeFilter);
    if (tteFilter !== "all") params.set("maxTteDays", String(tteFilter));
    return `/api/logs/export?${params.toString()}`;
  }, [minRoi, positiveArbOnly, fromDate, toDate, debouncedSearch, eventType, arbTypeFilter, tteFilter]);
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
    invalidatePagination();
    setFromDate(from.toISOString());
    setToDate(to.toISOString());
  }, [invalidatePagination]);

  const resetFilters = useCallback(() => {
    const now = new Date();
    invalidatePagination();
    setSearchQuery("");
    setDebouncedSearch("");
    setMinRoi(0);
    setPositiveArbOnly(false);
    setFromDate(new Date(now.getTime() - 86_400_000).toISOString());
    setToDate(now.toISOString());
    setEventType("all");
    setArbTypeFilter("all");
    setTteFilter("all");
  }, [invalidatePagination]);


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
      {dataQuality?.latest?.state === 'degraded' && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
          <div className="font-semibold">Logs data quality degraded</div>
          <div className="mt-1">
            {(dataQuality.latest.breaches ?? []).map((breach) => `${breach.field}: ${breach.unavailablePct.toFixed(2)}% unavailable (${breach.trigger})`).join('; ')
              || 'Required historical fields failed the availability contract; bounded reconciliation was triggered.'}
          </div>
        </div>
      )}
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
        <div className="mb-1 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <Filter className="w-4 h-4 text-[#8A9BA8]" />
            <span className="text-xs font-semibold text-[#8A9BA8] uppercase tracking-wide">Filters</span>
          </div>
          <button
            type="button"
            onClick={resetFilters}
            className="min-h-11 rounded px-2 text-[10px] font-medium uppercase tracking-wide text-[#8A9BA8] hover:text-[#FFFFFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5DBE81]"
          >
            Reset filters
          </button>
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
            <div className="mb-1 flex items-center justify-between gap-2">
              <label htmlFor="logs-min-roi" className="text-[10px] text-[#8A9BA8]">Min ROI %</label>
              <div className="flex items-center gap-1.5">
                <output htmlFor="logs-min-roi" className="font-mono text-xs font-semibold text-[#FFFFFF]">{minRoi.toFixed(2)}%</output>
                {minRoi > 0 && (
                  <button
                    type="button"
                    aria-label="Reset minimum ROI"
                    onClick={() => { invalidatePagination(); setMinRoi(0); }}
                    className="rounded px-1 text-[10px] text-[#8A9BA8] hover:text-[#FFFFFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5DBE81]"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
            <input
              id="logs-min-roi"
              type="range"
              min="0"
              max={maxRoi}
              step="0.01"
              value={minRoi}
              disabled={loading || maxRoi <= 0}
              aria-valuetext={`${minRoi.toFixed(2)}%`}
              onChange={(e) => { invalidatePagination(); setMinRoi(Number(e.target.value)); }}
              className="settings-slider w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5DBE81] focus-visible:ring-offset-2 focus-visible:ring-offset-[#17212B] disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div className="mt-1 flex justify-between font-mono text-[9px] text-[#8A9BA8]" aria-hidden="true">
              <span>0.00%</span>
              <span>{maxRoi.toFixed(2)}%</span>
            </div>
          </div>

          {/* From Date */}
          <div>
            <label htmlFor="logs-from-date" className="block text-[10px] text-[#8A9BA8] mb-1">From Date</label>
            <input
              id="logs-from-date"
              type="datetime-local"
              value={fromDate.slice(0, 16)}
              onChange={(e) => { invalidatePagination(); setFromDate(e.target.value ? new Date(e.target.value).toISOString() : ""); }}
              className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
            />
          </div>

          {/* To Date */}
          <div>
            <label htmlFor="logs-to-date" className="block text-[10px] text-[#8A9BA8] mb-1">To Date</label>
            <input
              id="logs-to-date"
              type="datetime-local"
              value={toDate.slice(0, 16)}
              onChange={(e) => { invalidatePagination(); setToDate(e.target.value ? new Date(e.target.value).toISOString() : ""); }}
              className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
            />
          </div>
        </div>

        {/* Segmented filters */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="logs-segmented-filter-row">
          <label className="flex min-h-11 items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={positiveArbOnly}
              onChange={(e) => { invalidatePagination(); setPositiveArbOnly(e.target.checked); }}
              className="w-4 h-4 accent-[#5DBE81] rounded"
            />
            <span className="text-xs text-[#8A9BA8]">Positive arb only</span>
          </label>
          {/* Date-range presets */}
          <div className="flex max-w-full items-center gap-1.5">
            <span className="shrink-0 text-[10px] text-[#8A9BA8] uppercase tracking-wide">Preset:</span>
            <div className="flex max-w-full items-center gap-0.5 overflow-x-auto bg-[#0E1621] rounded-lg p-0.5 border border-[#182533]">
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
                  className="min-h-11 shrink-0 px-2.5 py-1 rounded text-[10px] font-medium transition-colors text-[#8A9BA8] hover:text-[#FFFFFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5DBE81]"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {/* Event type filter pills */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">Type:</span>
            <div className="flex items-center gap-0.5 bg-[#0E1621] rounded-lg p-0.5 border border-[#182533]">
              {EVENT_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => { invalidatePagination(); setEventType(opt.key); }}
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
                  onClick={() => { invalidatePagination(); setArbTypeFilter(opt.key); }}
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
          {/* Cumulative scan-time TTE filter */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">TTE:</span>
            <div className="flex items-center gap-0.5 bg-[#0E1621] rounded-lg p-0.5 border border-[#182533]">
              {TTE_FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  aria-label={opt.ariaLabel}
                  aria-pressed={tteFilter === opt.key}
                  onClick={() => { invalidatePagination(); setTteFilter(opt.key); }}
                  className={`min-h-11 px-2.5 py-1 rounded text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5DBE81] ${
                    tteFilter === opt.key
                      ? "bg-[#5DBE81]/20 text-[#5DBE81]"
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
            ref={tableScrollerRef}
            className="max-h-[70vh] overflow-x-auto overflow-y-auto"
            data-testid="logs-table-scroll"
            onScroll={(event) => {
              const scroller = event.currentTarget;
              setTableScrollTop(scroller.scrollTop);
              if (
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 600
                && scroller.scrollTop > lastLoadScrollTop.current
              ) {
                lastLoadScrollTop.current = scroller.scrollTop;
                void loadMore();
              }
            }}
          >
            <table className="w-full min-w-[1340px] text-sm">
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
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    Validation
                  </th>
                  <th aria-label="BotTrader Status" className="px-3 py-2.5 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    BotTrader Status
                  </th>
                  <th aria-label="Scan Status" className="px-3 py-2.5 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    <span className="group relative inline-flex items-center gap-1">
                      <span>Scan Status</span>
                      <button
                        type="button"
                        aria-label="About scan status"
                        aria-describedby="scan-status-header-description"
                        title={SCAN_STATUS_HEADER_EXPLANATION}
                        className="rounded text-[#8A9BA8] hover:text-[#FFFFFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5DBE81]"
                      >
                        <CircleHelp aria-hidden="true" className="h-3 w-3" />
                      </button>
                      <span id="scan-status-header-description" className="sr-only">{SCAN_STATUS_HEADER_EXPLANATION}</span>
                      <span
                        aria-hidden="true"
                        data-scan-status-header-tooltip
                        className="pointer-events-none invisible absolute left-0 top-full z-40 mt-1 w-80 max-w-[calc(100vw-2rem)] whitespace-normal rounded border border-[#3A4A59] bg-[#0E1621] p-2 text-left text-[10px] font-normal normal-case leading-relaxed tracking-normal text-[#D5DEE5] opacity-0 shadow-xl transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
                      >
                        {SCAN_STATUS_HEADER_EXPLANATION}
                      </span>
                    </span>
                  </th>

                  <th
                    className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide cursor-pointer hover:text-[#FFFFFF] whitespace-nowrap"
                    onClick={() => toggleSort("best_roi_pct")}
                  >
                    ROI % {sortKey === "best_roi_pct" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />) : null}
                  </th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap">
                    Current ROI %
                  </th>
                  <th
                    className="px-3 py-2.5 text-center text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide whitespace-nowrap"
                    title="TRUE when scan-time ROI is greater than Current ROI."
                  >
                    ROI Declined?
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
                  <tr aria-hidden="true"><td colSpan={19} style={{ height: visibleWindow.start * LOG_ROW_HEIGHT, padding: 0 }} /></tr>
                )}
                {visibleWindow.rows.map((log, i) => (
                  <LogRow key={log.id ?? i} log={log} currentRoi={currentRoiById.get(log.id) ?? { status: 'loading' }} expanded={expandedId === log.id} onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)} fmtPct={fmtPct} fmtUsd={fmtUsd} fmtTime={fmtTime} savedMarkets={savedMarkets} />
                ))}
                {visibleWindow.end < sorted.length && (
                  <tr aria-hidden="true"><td colSpan={19} style={{ height: (sorted.length - visibleWindow.end) * LOG_ROW_HEIGHT, padding: 0 }} /></tr>
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

const ARB_INVALIDATION_REASON_LABELS: Record<string, string> = {
  legacy_internal_yes_yes_directional_duplication: 'Legacy Internal YES+YES duplicates the same directional exposure.',
  arb_type_strategy_mismatch: 'Stored arb type does not match the canonical strategy classification.',
  unrecognized_arbitrage_strategy: 'Strategy does not match a canonical arbitrage classification.',
};

function arbInvalidationReasonLabel(reason: string | null): string {
  if (!reason) return 'Classification failed canonical arbitrage validation.';
  return ARB_INVALIDATION_REASON_LABELS[reason] ?? reason.replaceAll('_', ' ');
}

const SCAN_STATUS_TEXT_CLASS: Record<ScanStatusTone, string> = {
  success: 'text-[#5DBE81]',
  progress: 'text-[#facc15]',
  warning: 'text-amber-300',
  error: 'text-[#ef4444]',
  unavailable: 'text-[#8A9BA8]',
};

function ScanStatusIndicator({ log }: { log: LogEntry }) {
  const presentation = scanStatusPresentation(log.scan_status, log.scan_status_reason);
  const descriptionId = `scan-status-description-${log.id}`;

  return (
    <span className="group relative inline-flex">
      <span
        role="status"
        tabIndex={0}
        aria-label={`Scan status: ${presentation.label}`}
        aria-describedby={descriptionId}
        title={presentation.explanation}
        onClick={(event) => event.stopPropagation()}
        className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5DBE81] ${SCAN_STATUS_TEXT_CLASS[presentation.tone]}`}
      >
        {presentation.label}
      </span>
      <span id={descriptionId} className="sr-only">{presentation.explanation}</span>
      <span
        aria-hidden="true"
        data-scan-status-tooltip
        className="pointer-events-none invisible absolute left-0 top-full z-40 mt-1 w-80 max-w-[calc(100vw-2rem)] whitespace-normal rounded border border-[#3A4A59] bg-[#0E1621] p-2 text-[10px] font-normal leading-relaxed text-[#D5DEE5] opacity-0 shadow-xl transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {presentation.explanation}
      </span>
    </span>
  );
}

const BOT_TRADER_STATUS_PRESENTATION: Record<BotTraderEvaluationStatus, {
  label: string;
  dotClass: string;
  textClass: string;
}> = {
  completed: { label: 'Completed', dotClass: 'bg-[#5DBE81]', textClass: 'text-[#5DBE81]' },
  pending: { label: 'Pending', dotClass: 'bg-[#facc15]', textClass: 'text-[#facc15]' },
  partial: { label: 'Partial', dotClass: 'bg-[#ef4444]', textClass: 'text-[#ef4444]' },
  failed: { label: 'Failed', dotClass: 'bg-[#ef4444]', textClass: 'text-[#ef4444]' },
  not_run_disabled: { label: 'Disabled', dotClass: 'bg-[#ef4444]', textClass: 'text-[#ef4444]' },
  not_applicable_no_positive_arb: { label: 'N/A', dotClass: 'bg-[#8A9BA8]', textClass: 'text-[#8A9BA8]' },
};

function evaluationCount(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? String(value)
    : 'unavailable';
}

function BotTraderEvaluationIndicator({ log }: { log: LogEntry }) {
  const evaluation = log.botTraderEvaluation;
  const status = evaluation?.status ?? log.botTraderEvaluationStatus ?? 'pending';
  const completed = status === 'completed'
    && (log.botTraderEvaluationCompleted ?? evaluation?.botTraderEvaluationCompleted ?? false);
  const presentation = BOT_TRADER_STATUS_PRESENTATION[status];
  const timestamp = evaluation?.completedAt ?? evaluation?.updatedAt ?? evaluation?.startedAt ?? 'Unavailable';
  const reason = evaluation?.reason ?? 'BotTrader evaluation envelope is not yet available.';
  const missing = evaluation?.missingCandidateIndexes?.length
    ? evaluation.missingCandidateIndexes.join(', ')
    : 'none';
  const failing = evaluation?.failingCandidateIndexes?.length
    ? evaluation.failingCandidateIndexes.join(', ')
    : 'none';
  const detail = [
    `Status: ${status}`,
    `Evaluation timestamp: ${timestamp}`,
    `Candidates evaluated: ${evaluationCount(evaluation?.evaluatedCount)} of ${evaluationCount(evaluation?.candidateCount)}`,
    `Eligible: ${evaluationCount(evaluation?.eligibleCount)}`,
    `Placement attempts: ${evaluationCount(evaluation?.placementAttemptCount)}`,
    `Placed: ${evaluationCount(evaluation?.placedCount)}`,
    `Skipped: ${evaluationCount(evaluation?.skippedCount)}`,
    `Failures: ${evaluationCount(evaluation?.failureCount)}`,
    `Missing candidate indexes: ${missing}`,
    `Failing candidate indexes: ${failing}`,
    `Reason: ${reason}`,
  ].join('. ');
  const descriptionId = `bot-trader-evaluation-${log.id}`;

  return (
    <span className="group relative inline-flex">
      <span
        role="status"
        tabIndex={0}
        aria-label={`BotTrader evaluation: ${status}; completed: ${completed ? 'yes' : 'no'}`}
        aria-describedby={descriptionId}
        title={detail}
        onClick={(event) => event.stopPropagation()}
        className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5DBE81] ${presentation.textClass}`}
      >
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${presentation.dotClass}`} />
        {presentation.label}
      </span>
      <span id={descriptionId} className="sr-only">{detail}</span>
      <span
        aria-hidden="true"
        data-bot-trader-evaluation-tooltip
        className="pointer-events-none invisible absolute left-0 top-full z-40 mt-1 w-80 whitespace-normal rounded border border-[#3A4A59] bg-[#0E1621] p-2 text-[10px] font-normal leading-relaxed text-[#D5DEE5] opacity-0 shadow-xl transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {detail}
      </span>
    </span>
  );
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
  currentRoi,
  expanded,
  onToggle,
  fmtPct,
  fmtUsd,
  fmtTime,
  savedMarkets,
}: {
  log: LogEntry;
  currentRoi: CurrentRoiValuation;
  expanded: boolean;
  onToggle: () => void;
  fmtPct: (n: number) => string;
  fmtUsd: (n: number) => string;
  fmtTime: (s: string) => string;
  savedMarkets: Map<string, { title: string; expiryDate?: string | null }>;
}) {
  const scanEnvelope = parseCalculationEnvelope(log.calculation_envelope, `scan log ${log.id}`);
  const historical = log.historical_financials ?? resolveHistoricalScanFinancials(log);
  const scanTimeRoi = historical.fields.roiPct.status === 'available' ? historical.fields.roiPct.value : null;
  const scanProfit = historical.fields.profitUsd.status === 'available' ? historical.fields.profitUsd.value : null;
  const scanStake = historical.fields.stakeUsd.status === 'available' ? historical.fields.stakeUsd.value : null;
  const roiColor = scanTimeRoi == null ? "text-[#8A9BA8]" : scanTimeRoi > 0 ? "text-[#5DBE81]" : scanTimeRoi < 0 ? "text-[#ef4444]" : "text-[#FFFFFF]";
  const arbProjection = projectCanonicalArbClassification(log);
  const arbBadge = arbProjection.positiveArbCount > 0 ? "bg-[#5DBE81]/10 text-[#5DBE81]" : "text-[#8A9BA8]";
  const arbIsValid = arbProjection.arbValid === 1;
  const arbTypeMeta = arbProjection.arbType
    ? ARB_TYPES[arbProjection.arbType]
    : null;
  const apy = historical.fields.apyPct.status === 'available' ? historical.fields.apyPct.value : null;
  const currentRoiValue = currentRoi.status === 'available'
    && typeof currentRoi.roiPct === 'number'
    && Number.isFinite(currentRoi.roiPct)
    ? currentRoi.roiPct
    : null;
  const roiDecline = compareRoiDecline(scanTimeRoi, currentRoiValue);
  const roiDeclineText = roiDecline.declined == null ? 'Unavailable' : roiDecline.declined ? 'TRUE' : 'FALSE';
  const roiDeclineUnavailableReason = roiDecline.unavailableInputs.length === 0
    ? null
    : roiDecline.unavailableInputs.map((input) => input === 'Current ROI'
      ? `Current ROI is unavailable: ${currentRoi.reason ?? currentRoiStatusLabel(currentRoi.status)}`
      : 'scan-time ROI is unavailable').join('; ');
  const roiDeclineTitle = roiDeclineUnavailableReason
    ? `ROI Declined? unavailable — ${roiDeclineUnavailableReason}.`
    : `ROI Declined? ${roiDeclineText} — compared using full-precision persisted ROI values.`;
  const roiDeclineDescriptionId = `roi-declined-reason-${log.id}`;
  // Kept at row scope so collapsing does not discard the brief lazy-fetch cache.
  const [comparisonCache] = useState<ComparisonCache>(() => new Map());
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [detailRawResult, setDetailRawResult] = useState<string | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const detailRequestController = useRef<AbortController | null>(null);
  const detailRequestGeneration = useRef(0);

  useEffect(() => () => {
    detailRequestGeneration.current += 1;
    detailRequestController.current?.abort();
    detailRequestController.current = null;
  }, []);

  useEffect(() => {
    if (!expanded || detailState !== 'idle' || detailRequestController.current) return;
    const generation = detailRequestGeneration.current + 1;
    detailRequestGeneration.current = generation;
    const controller = new AbortController();
    detailRequestController.current = controller;
    setDetailState('loading');
    void fetch(`/api/logs/${log.id}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load scan details');
        if (detailRequestGeneration.current === generation) {
          setDetailRawResult(typeof data.raw_result === 'string' ? data.raw_result : null);
          setDetailState('ready');
        }
      })
      .catch((error: unknown) => {
        if (detailRequestGeneration.current === generation && !(error instanceof DOMException && error.name === 'AbortError')) {
          setDetailState('error');
        }
      })
      .finally(() => {
        if (detailRequestGeneration.current === generation) detailRequestController.current = null;
      });
  }, [detailAttempt, detailState, expanded, log.id]);

  const savedMarket = savedMarkets.get(log.market_id);
  const marketName = log.market_name ?? log.market_title ?? savedMarket?.title;
  const minutesToExpiry = typeof log.days_to_expiry === 'number' && Number.isFinite(log.days_to_expiry)
    ? Math.floor(log.days_to_expiry * 1440)
    : null;
  const tte = minutesToExpiry == null ? '—' : minutesToExpiry <= 0 ? 'Expired' : minutesToExpiry >= 1440 ? `${Math.floor(minutesToExpiry / 1440)}d ${Math.floor(minutesToExpiry % 1440 / 60)}h` : minutesToExpiry >= 60 ? `${Math.floor(minutesToExpiry / 60)}h ${minutesToExpiry % 60}m` : `${minutesToExpiry}m`;
  const hasMarketName = !!marketName;

  const handleNavigate = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.location.href = `/?view=scan&id=${encodeURIComponent(log.market_id)}`;
  };

  // Parse the lazily loaded raw_result for expanded view.
  let rawArbs: unknown[] = [];
  if (expanded && detailRawResult) {
    try {
      const parsed = JSON.parse(detailRawResult) as { allArbs?: unknown[]; arbs?: unknown[] } | null;
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
        <td className="px-3 py-2 text-xs whitespace-nowrap">
          {!arbIsValid ? (
            <div className="max-w-[260px] whitespace-normal" role="status">
              <span className="inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
                <AlertTriangle className="h-3 w-3" />
                Failed validation
              </span>
              <div className="mt-1 text-[10px] leading-tight text-red-300">
                {arbInvalidationReasonLabel(arbProjection.arbInvalidationReason)}
              </div>
            </div>
          ) : (
            <span className="text-[10px] text-[#8A9BA8]">Passed</span>
          )}
        </td>
        <td className="px-3 py-2 text-xs whitespace-nowrap">
          <BotTraderEvaluationIndicator log={log} />
        </td>
        <td className="px-3 py-2 text-xs whitespace-nowrap">
          <ScanStatusIndicator log={log} />
        </td>
        <td className={`px-3 py-2 text-right text-xs font-mono font-semibold ${roiColor}`} title={historical.fields.roiPct.status === 'unavailable' ? historical.fields.roiPct.reason : 'ROI captured at scan time'}>
          {scanTimeRoi == null ? 'Unavailable' : fmtPct(scanTimeRoi)}
        </td>
        <td className="px-3 py-2 text-right text-[11px] font-mono text-[#8A9BA8] whitespace-nowrap" title={currentRoi.scannedAt ? `Latest persisted scan: ${currentRoi.scannedAt}${currentRoi.strategy ? ` — ${currentRoi.strategy}` : ''}` : currentRoi.reason ?? currentRoiStatusLabel(currentRoi.status)}>
          {currentRoiValue != null
            ? `${currentRoiValue.toFixed(2)}%`
            : currentRoiStatusLabel(currentRoi.status)}
        </td>
        <td className="px-3 py-2 text-center whitespace-nowrap">
          <span
            aria-label={`ROI Declined? ${roiDeclineText}`}
            aria-describedby={roiDeclineDescriptionId}
            tabIndex={0}
            title={roiDeclineTitle}
            className={`inline-flex min-w-11 items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${roiDecline.declined
              ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
              : 'border-[#3A4A59] bg-[#182533] text-[#A8B8C4]'}`}
          >
            {roiDeclineText}
          </span>
          <span id={roiDeclineDescriptionId} className="sr-only">{roiDeclineTitle}</span>
        </td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#facc15]" title={historical.fields.profitUsd.status === 'unavailable' ? historical.fields.profitUsd.reason : 'Profit captured at scan time'}>{scanProfit == null ? 'Unavailable' : fmtUsd(scanProfit)}</td>
        <td
          className={`px-3 py-2 text-right text-xs font-mono ${apy != null ? "text-[#5DBE81]" : "text-[#8A9BA8]"}`}
          title={historical.fields.apyPct.status === 'unavailable' ? historical.fields.apyPct.reason : 'APY captured at scan time'}
        >{apy != null ? fmtPct(apy) : "Unavailable"}</td>
        <td className={`px-3 py-2 text-right text-xs font-mono ${minutesToExpiry != null && minutesToExpiry <= 0 ? 'text-[#ef4444]' : 'text-[#8A9BA8]'}`}>{tte}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#FFFFFF]">{log.matched_count}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#8A9BA8]">{log.kalshi_count} / {log.pm_count}</td>
        <td className={`px-3 py-2 text-right text-xs font-mono ${arbBadge}`}>{arbProjection.positiveArbCount}</td>
        <td className="px-3 py-2 text-right text-xs font-mono text-[#8A9BA8]" title={historical.fields.stakeUsd.status === 'unavailable' ? historical.fields.stakeUsd.reason : 'Stake captured at scan time'}>{scanStake == null ? 'Unavailable' : fmtUsd(scanStake)}</td>
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
          <td colSpan={19} className="px-4 py-3">
            {detailState === 'loading' || detailState === 'idle' ? (
              <div className="text-xs text-[#8A9BA8]" role="status">Loading scan details…</div>
            ) : detailState === 'error' ? (
              <div className="flex items-center gap-3 text-xs text-[#ef4444]" role="alert">
                <span>Unable to load scan details.</span>
                <button
                  type="button"
                  aria-label="Retry scan details"
                  className="rounded border border-[#ef4444]/40 px-2 py-1 text-[#FFFFFF] hover:bg-[#ef4444]/10"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDetailState('idle');
                    setDetailAttempt((attempt) => attempt + 1);
                  }}
                >Retry</button>
              </div>
            ) : rawArbs.length > 0 ? (
              <div className="space-y-2">
                <CalculationProvenance envelope={scanEnvelope} compact />
                <div className="text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide mb-2">Arbitrage Opportunities ({rawArbs.length})</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {rawArbs.map((rawArb, i) => {
                    const arb = rawArb as Record<string, unknown>;
                    const arbEnvelope = parseCalculationEnvelope(arb.calculationEnvelope, `scan opportunity ${log.id}`);
                    const arbNetMicros = arbEnvelope.status === 'executable' ? arbEnvelope.totals.netPnlMicros : null;
                    const arbCostMicros = arbEnvelope.status === 'executable' ? arbEnvelope.totals.grossCostMicros : null;
                    const arbRoiPct = arbNetMicros != null && arbCostMicros != null && arbCostMicros > 0
                      ? arbNetMicros / arbCostMicros * 100
                      : null;
                    const opportunityProjection = projectCanonicalArbClassification({
                      strategy: arb.strategy,
                      arb_type: arb.arbType,
                      arb_invalidation_reason: arb.arbInvalidationReason,
                      positive_arb_count: arbEnvelope.status === 'executable'
                        && typeof arb.expectedProfit === 'number'
                        && arb.expectedProfit > 0 ? 1 : 0,
                    });
                    const opportunityTypeMeta = opportunityProjection.arbType
                      ? ARB_TYPES[opportunityProjection.arbType]
                      : null;
                    return (
                    <div key={i} className="rounded-lg border border-[#182533] bg-[#17212B] p-3 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-[#FFFFFF]">{String(arb.artist || arb.strategy || "—")}</span>
                        <div className="flex items-center gap-2">
                          {opportunityTypeMeta ? (
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${opportunityTypeMeta.badgeClass}`}>
                              <span className={`inline-block w-1.5 h-1.5 rounded-full ${opportunityTypeMeta.dotClass}`} />
                              {opportunityTypeMeta.label}
                            </span>
                          ) : null}
                          <span className={`text-xs font-mono font-semibold ${arbRoiPct == null ? "text-[#8A9BA8]" : arbRoiPct > 0 ? "text-[#5DBE81]" : "text-[#ef4444]"}`}>
                            {arbRoiPct == null ? 'Unavailable' : fmtPct(arbRoiPct)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-[#8A9BA8]">
                        <span>Profit: <span className="text-[#facc15] font-mono">{arbNetMicros == null ? 'Unavailable' : fmtUsd(arbNetMicros / 1_000_000)}</span></span>
                        <span>{String(arb.strategy)}</span>
                      </div>
                      {arbEnvelope.status === 'executable' && <HistoricalCurrentPriceComparison arb={arb} cache={comparisonCache} />}
                      <CalculationProvenance envelope={arbEnvelope} compact />
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