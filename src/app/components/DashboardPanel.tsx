"use client";

import {
  Activity,
  TrendingUp,
  Zap,
  Target,
  Globe,
  RefreshCw,
  BarChart3,
  Layers,
  AlertTriangle,
  Eye,
  Clock,
  DollarSign,
  HardDrive,
} from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { LifecycleStatsPanel } from "./LifecycleStatsPanel";
import { CompactStrategyDisplay } from "./ArbLegBreakdown";
import { DecisionCommandCenter } from "./dashboard/DecisionCommandCenter";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Cell,
  PieChart,
  Pie,
  AreaChart,
  Area,
} from "recharts";

// ── Types ────────────────────────────────────────────────────────
interface KPISummary {
  totalArbsFound: number;
  activeArbs: number;
  totalScans: number;
  avgRoi: number;
  marketsTracked: number;
  totalProfit: number;
}

interface ScanPerDay {
  date: string;
  count: number;
}

interface ROIBucket {
  label: string;
  low: number;
  high: number;
  count: number;
}

interface TimelinePoint {
  time: string;
  scans: number;
  avgRoi: number;
}

interface ActiveArb {
  id: number;
  market_id: string;
  market_title: string | null;
  best_roi_pct: number;
  best_profit: number;
  strategy: string;
  positive_arb_count: number;
  scanned_at: string;
}

interface MarketCoverageItem {
  name: string;
  value: number;
}

interface ProfitTimelinePoint {
  time: string;
  profit: number;
}

interface LifecycleFunnel {
  found: number;
  active: number;
  recurring: number;
  vanished: number;
  expired: number;
}

interface ArbTypeItem {
  type: string;
  count: number;
  totalProfit: number;
  avgRoi: number;
}

interface DashboardData {
  kpis: KPISummary;
  scansPerDay: ScanPerDay[];
  roiDistribution: ROIBucket[];
  timeline: TimelinePoint[];
  topActiveArbs: ActiveArb[];
  marketCoverage: MarketCoverageItem[];
  profitTimeline: ProfitTimelinePoint[];
  lifecycleFunnel: LifecycleFunnel;
  arbTypeBreakdown: ArbTypeItem[];
  range: string;
  capacity?: CapacityData;
}

interface CapacityPoint {
  hour: string;
  utilizationPct: number;
  isThrottled: number;
  avgQueueWaitMs: number;
  rejectedRequests: number;
}

interface CapacitySeries {
  name: string;
  data: CapacityPoint[];
}

interface CapacityData {
  range: string;
  hours: string[];
  series: CapacitySeries[];
}

interface DailyPnlSummary {
  date: string;
  timezone: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  totalTrades: number;
  winRatePct: number;
  totalVolume: number;
  platforms: {
    kalshi: { realizedPnl: number; volume: number };
    polymarket: { realizedPnl: number; volume: number };
  };
}

interface StorageSummary {
  diskTotal: number;
  diskUsed: number;
  diskFree: number;
  diskPercent: number;
  dbSize: number;
  walSize: number;
  dataDirSize: number;
  scanRowCount: number;
  oldestScan: string | null;
  retentionDays: number;
}

type RangeKey = "today" | "7d" | "30d" | "90d" | "all";
const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 Days" },
  { key: "30d", label: "30 Days" },
  { key: "90d", label: "90 Days" },
  { key: "all", label: "All" },
];

// ── Helpers ──────────────────────────────────────────────────────
const fmtPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });

const fmtBytes = (n: number) => {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(n) / Math.log(1024)),
    units.length - 1,
  );
  const value = n / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1).replace(/\.0$/, "")} ${units[i]}`;
};

const fmtShortDate = (s: string) => {
  const d = new Date(s);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const fmtTime = (s: string) => {
  const d = new Date(s);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// ── Reusable card wrapper ────────────────────────────────────────
function Panel({
  title,
  icon,
  children,
  rightElement,
  className,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  rightElement?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4 ${className ?? ''}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          {icon}
          {title}
        </h3>
        {rightElement}
      </div>
      {children}
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────
function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-16 text-center text-sm text-[var(--text-secondary)]">
      <Layers className="w-8 h-8 mx-auto mb-2 opacity-40" />
      {message}
    </div>
  );
}

// ── Custom tooltip for charts ────────────────────────────────────
const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[var(--surface-workspace)] border border-[var(--border-subtle)] rounded-lg p-3 shadow-lg">
      <p className="text-xs text-[var(--text-secondary)] mb-1">{label}</p>
      {payload.map((entry: any, i: number) => (
        <p key={i} className="text-xs font-mono" style={{ color: entry.color }}>
          {entry.name}: {entry.value}
        </p>
      ))}
    </div>
  );
};

// ── Main Component ───────────────────────────────────────────────
export default function DashboardPanel() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [dailyPnl, setDailyPnl] = useState<DailyPnlSummary | null>(null);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [range, setRange] = useState<RangeKey>("30d");
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [res, pnlRes, storageRes, capacityRes] = await Promise.all([
        fetch(`/api/dashboard/stats?range=${range}`, { cache: "no-store" }),
        fetch("/api/dashboard/daily-pnl", { cache: "no-store" }).catch(() => null),
        fetch("/api/dashboard/storage", { cache: "no-store" }).catch(() => null),
        fetch(`/api/dashboard/capacity?range=${range}`, { cache: "no-store" }).catch(() => null),
      ]);
      const json = await res.json();
      if (storageRes?.ok) {
        const storageJson = await storageRes.json();
        if (!storageJson.error) setStorage(storageJson);
      }
      if (pnlRes?.ok) {
        const pnlJson = await pnlRes.json();
        if (!pnlJson.error) setDailyPnl(pnlJson);
      }
      if (capacityRes?.ok) {
        const capacityJson = await capacityRes.json();
        if (!capacityJson.error) json.capacity = capacityJson;
      }
      if (json.error) {
        setError(json.error);
      } else {
        setData(json);
        setError("");
      }
    } catch (e: any) {
      setError(e.message || "Failed to fetch dashboard data");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh every 60s
  useEffect(() => {
    if (!autoRefresh) return;
    const iv = setInterval(fetchData, 60000);
    return () => clearInterval(iv);
  }, [autoRefresh, fetchData]);

  if (loading) {
    return (
      <div className="py-20 text-center text-sm text-[var(--text-secondary)]">
        <Activity className="w-6 h-6 animate-spin mx-auto mb-3" />
        Loading dashboard…
      </div>
    );
  }

  if (!data && error) {
    return (
      <div className="py-20 text-center text-sm text-[var(--status-negative)]">
        <AlertTriangle className="w-6 h-6 mx-auto mb-3" />
        {error}
      </div>
    );
  }

  const kpis = data!.kpis;
  const hasData = kpis.totalScans > 0;

  return (
    <div className="flex flex-col gap-5 tabular-nums">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="w-5 h-5 text-[var(--status-positive)]" />
          Dashboard
        </h2>
        <div className="flex items-center gap-3">
          {/* Date range selector */}
          <div className="flex items-center gap-1 bg-[var(--border-subtle)] rounded-lg p-0.5">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                onClick={() => setRange(opt.key)}
                className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                  range === opt.key
                    ? "bg-[var(--status-positive)]/20 text-[var(--status-positive)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              autoRefresh
                ? "bg-[var(--status-positive)]/10 text-[var(--status-positive)] border-[var(--status-positive)]/30"
                : "bg-[var(--border-subtle)] text-[var(--text-secondary)] border-[var(--border-subtle)] hover:text-[var(--text-primary)]"
            }`}
            title="Auto-refresh every 60s"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${autoRefresh ? "animate-spin" : ""}`} />
            {autoRefresh ? "On" : "Off"}
          </button>
        </div>
      </div>

      {/* DES-005: financial risk and actionability outrank historical analytics. */}
      <DecisionCommandCenter />

      {/* UI-025: at-a-glance live trading performance for the US Eastern day. */}
      {dailyPnl && (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <DollarSign className="h-4 w-4 text-[var(--status-positive)]" /> Today&apos;s P&amp;L
            </div>
            <span className="text-[10px] text-[var(--text-secondary)]">US Eastern · {dailyPnl.date}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {[
              ["Total P&L", fmtUsd(dailyPnl.totalPnl), dailyPnl.totalPnl],
              ["Realized", fmtUsd(dailyPnl.realizedPnl), dailyPnl.realizedPnl],
              ["Unrealized", fmtUsd(dailyPnl.unrealizedPnl), dailyPnl.unrealizedPnl],
            ].map(([label, value, amount]) => (
              <div key={String(label)} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{String(label)}</div>
                <div className={`text-sm font-semibold tabular-nums ${Number(amount) > 0 ? "text-[var(--status-positive)]" : Number(amount) < 0 ? "text-[var(--status-negative)]" : "text-white"}`}>{String(value)}</div>
              </div>
            ))}
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">Trades</div>
              <div className="text-sm font-semibold tabular-nums">{dailyPnl.totalTrades}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">Win rate</div>
              <div className="text-sm font-semibold tabular-nums">{dailyPnl.winRatePct.toFixed(1)}%</div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">Volume</div>
              <div className="text-sm font-semibold tabular-nums">{fmtUsd(dailyPnl.totalVolume)}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-[var(--text-secondary)]">
            <span>Kalshi: <b className="text-white">{fmtUsd(dailyPnl.platforms.kalshi.volume)}</b> volume · <b className={dailyPnl.platforms.kalshi.realizedPnl >= 0 ? "text-[var(--status-positive)]" : "text-[var(--status-negative)]"}>{fmtUsd(dailyPnl.platforms.kalshi.realizedPnl)}</b> realized</span>
            <span>Polymarket: <b className="text-white">{fmtUsd(dailyPnl.platforms.polymarket.volume)}</b> volume · <b className={dailyPnl.platforms.polymarket.realizedPnl >= 0 ? "text-[var(--status-positive)]" : "text-[var(--status-negative)]"}>{fmtUsd(dailyPnl.platforms.polymarket.realizedPnl)}</b> realized</span>
          </div>
        </div>
      )}

      {/* ── 5 KPI Cards ──────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KPICard
          icon={<Zap className="w-4 h-4" />}
          label="Total Arbs Found"
          value={kpis.totalArbsFound.toLocaleString()}
          color="var(--status-positive)"
        />
        {/* BUG-01: "Active Arbs Now" = count of markets where the latest scan
            (liveResult ?? lastScanResult) has bestRoiPct > 0. Computed in the
            stats route from saved_markets — same data source and criteria as
            the MarketSidebar "Arb Only" filter. */}
        <KPICard
          icon={<Eye className="w-4 h-4" />}
          label="Active Arbs Now"
          value={kpis.activeArbs.toLocaleString()}
          color="var(--status-warning)"
        />
        <KPICard
          icon={<BarChart3 className="w-4 h-4" />}
          label="Total Scans"
          value={kpis.totalScans.toLocaleString()}
          color="var(--text-primary)"
        />
        <KPICard
          icon={<TrendingUp className="w-4 h-4" />}
          label="Avg ROI"
          value={fmtPct(kpis.avgRoi)}
          color={kpis.avgRoi > 0 ? "var(--status-positive)" : "var(--status-negative)"}
        />
        <KPICard
          icon={<Globe className="w-4 h-4" />}
          label="Markets Tracked"
          value={kpis.marketsTracked.toString()}
          color="var(--platform-polymarket)"
        />
      </div>

      {/* ── API Capacity Utilization (line chart) ───────── */}
      {data?.capacity && data.capacity.series.length > 0 && (
        <Panel
          title="API Capacity Utilization"
          icon={<Activity className="w-4 h-4 text-[var(--status-info)]" />}
          rightElement={
            <span className="text-xs text-[var(--text-secondary)]">
              {range === "all" ? "All time" : range === "today" ? "Today" : `Last ${RANGE_OPTIONS.find(o => o.key === range)?.label ?? "30 days"}`}
            </span>
          }
        >
          <ResponsiveContainer width="100%" height={280} key={`capacity-${range}`}>
            <LineChart
              data={data.capacity.hours.map((hour) => {
                const point: Record<string, string | number> = { hour };
                for (const s of data.capacity!.series) {
                  const p = s.data.find((d) => d.hour === hour);
                  point[s.name] = p?.utilizationPct ?? 0;
                }
                return point;
              })}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis
                dataKey="hour"
                tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                tickFormatter={(val: string) => val.slice(5, 16)}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                domain={[0, 100]}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip
                content={({ active, payload, label }: any) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div className="bg-[var(--surface-workspace)] border border-[var(--border-subtle)] rounded-lg p-3 shadow-lg">
                      <p className="text-xs text-[var(--text-secondary)] mb-2">{label}</p>
                      {payload.map((entry: any, i: number) => {
                        const val = Number(entry.value ?? 0);
                        const color =
                          val >= 95
                            ? "var(--status-negative)"
                            : val >= 80
                              ? "var(--status-warning)"
                              : entry.color;
                        return (
                          <p key={i} className="text-xs font-mono" style={{ color }}>
                            {entry.name}: {val.toFixed(1)}%
                          </p>
                        );
                      })}
                    </div>
                  );
                }}
              />
              <Legend wrapperStyle={{ color: 'var(--text-secondary)', fontSize: '11px' }} />
              {data.capacity.series.map((s, i) => {
                const COLORS = ["var(--status-info)", "var(--status-positive)", "var(--status-warning)", "var(--platform-polymarket)"];
                const baseColor = COLORS[i % COLORS.length];
                return (
                  <Line
                    key={s.name}
                    type="monotone"
                    dataKey={s.name}
                    name={s.name}
                    stroke={baseColor}
                    strokeWidth={2}
                    dot={(props: any) => {
                      const val = Number(props.value ?? 0);
                      if (val >= 95) {
                        return <circle cx={props.cx} cy={props.cy} r={3} fill="var(--status-negative)" />;
                      }
                      if (val >= 80) {
                        return <circle cx={props.cx} cy={props.cy} r={3} fill="var(--status-warning)" />;
                      }
                      return <circle cx={props.cx} cy={props.cy} r={2} fill={baseColor} />;
                    }}
                    connectNulls
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </Panel>
      )}

      {/* ── Storage info box ───────────────────────────────── */}
      <Panel
        title="Storage"
        icon={<HardDrive className="w-4 h-4 text-[var(--text-secondary)]" />}
        rightElement={
          storage ? (
            <span className="text-[10px] text-[var(--text-secondary)]">{storage.retentionDays}d retention</span>
          ) : null
        }
      >
        {storage ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Disk usage</div>
              <div className="text-sm font-semibold tabular-nums mb-1.5">
                {fmtBytes(storage.diskUsed)} / {fmtBytes(storage.diskTotal)} ({storage.diskPercent}%)
              </div>
              <div className="h-2 w-full rounded-full bg-[var(--surface-workspace)] overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    storage.diskPercent >= 80 ? "bg-[var(--status-negative)]" : storage.diskPercent >= 60 ? "bg-[var(--status-warning)]" : "bg-[var(--status-positive)]"
                  }`}
                  style={{ width: `${Math.min(storage.diskPercent, 100)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">DB size</div>
              <div className="text-sm font-semibold tabular-nums text-white">{fmtBytes(storage.dbSize)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">WAL size</div>
              <div
                className={`text-sm font-semibold tabular-nums ${
                  storage.walSize > storage.dbSize * 0.5
                    ? storage.walSize > storage.dbSize
                      ? "text-[var(--status-negative)]"
                      : "text-[var(--status-warning)]"
                    : "text-white"
                }`}
              >
                {fmtBytes(storage.walSize)}
              </div>
              {storage.walSize > storage.dbSize * 0.5 && (
                <div className="text-[10px] text-[var(--status-warning)] mt-0.5">
                  WAL {'>'} 50% of DB — checkpoint problem
                </div>
              )}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Scan rows</div>
              <div className="text-sm font-semibold tabular-nums text-white">
                {storage.scanRowCount.toLocaleString()} rows
              </div>
              <div className="text-[10px] text-[var(--text-secondary)]">
                {storage.oldestScan
                  ? `since ${new Date(storage.oldestScan).toISOString().slice(0, 10)}`
                  : "no scans yet"}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-[var(--text-secondary)]">Storage data unavailable.</div>
        )}
      </Panel>

      {!hasData ? (
        <EmptyState message="No scan data yet. Run a scan to populate the dashboard." />
      ) : (
        <>
          {/* ── Row 1: Timeline + Scans Per Day ──────────── */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* Arb Discovery Timeline (line chart) */}
            <Panel
              title="Arb Discovery Timeline"
              icon={<Activity className="w-4 h-4 text-[var(--status-positive)]" />}
              rightElement={
                <span className="text-xs text-[var(--text-secondary)]">
                  {range === "all" ? "All time" : range === "today" ? "Today" : `Last ${RANGE_OPTIONS.find(o => o.key === range)?.label ?? "30 days"}`}
                </span>
              }
            >
              <ResponsiveContainer width="100%" height={260} key={`timeline-${range}`}>
                <LineChart data={data!.timeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                    tickFormatter={(val: string) => val.slice(5)}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 10, fill: "var(--status-positive)" }}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 10, fill: "var(--status-warning)" }}
                    domain={[0, "dataMax"]}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ color: 'var(--text-secondary)', fontSize: '11px' }} />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="scans"
                    name="Scans"
                    stroke="var(--status-positive)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="avgRoi"
                    name="Avg ROI %"
                    stroke="var(--status-warning)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </Panel>

            {/* Scans Per Day (bar chart) */}
            <Panel
              title="Scans Per Day"
              icon={<BarChart3 className="w-4 h-4 text-[var(--status-positive)]" />}
              rightElement={
                <span className="text-xs text-[var(--text-secondary)]">
                  {range === "all" ? "Last 365 days" : range === "today" ? "Today" : `Last ${RANGE_OPTIONS.find(o => o.key === range)?.label ?? "30 days"}`}
                </span>
              }
            >
              <ResponsiveContainer width="100%" height={260} key={`scans-${range}`}>
                <BarChart data={data!.scansPerDay}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 10, fill: "var(--text-secondary)" }} allowDecimals={false} />
                  <Tooltip
                    content={({ active, payload, label }: any) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="bg-[var(--surface-workspace)] border border-[var(--border-subtle)] rounded-lg p-3 shadow-lg">
                          <p className="text-xs text-[var(--text-secondary)]">{fmtShortDate(label)}</p>
                          <p className="text-xs font-mono text-[var(--status-positive)]">
                            {payload[0].value} scans
                          </p>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="count" name="Scans" radius={[3, 3, 0, 0]}>
                    {data!.scansPerDay.map((_, i) => (
                      <Cell
                        key={i}
                        fill={
                          data!.scansPerDay[i].count > 0
                            ? "var(--status-positive)"
                            : "var(--border-subtle)"
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          </div>

          {/* ── Row 2: ROI Histogram + Market Coverage ──────── */}
          <div className="order-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* ROI Distribution */}
            <Panel
              title="ROI Distribution"
              icon={<Target className="w-4 h-4 text-[var(--status-positive)]" />}
              rightElement={
                <span className="text-xs text-[var(--text-secondary)]">
                  Net of fees
                </span>
              }
            >
              <ResponsiveContainer width="100%" height={260} key={`roi-${range}`}>
                <BarChart
                  data={data!.roiDistribution.map((b) => ({
                    ...b,
                    color:
                      b.low >= 10
                        ? "var(--status-positive)"
                        : b.low >= 5
                          ? "var(--status-warning)"
                          : b.low >= 2
                            ? "var(--status-positive)"
                            : "var(--text-faint)",
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "var(--text-secondary)" }}
                  />
                  <YAxis tick={{ fontSize: 10, fill: "var(--text-secondary)" }} allowDecimals={false} />
                  <Tooltip
                    content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="bg-[var(--surface-workspace)] border border-[var(--border-subtle)] rounded-lg p-3 shadow-lg">
                          <p className="text-xs text-[var(--text-secondary)]">
                            ROI {payload[0]?.payload?.label}
                          </p>
                          <p className="text-xs font-mono text-[var(--status-positive)]">
                            {payload[0].value} scans
                          </p>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="count" name="Scans" radius={[4, 4, 0, 0]} maxBarSize={80}>
                    {data!.roiDistribution.map((b, i) => {
                      const c =
                        b.low >= 10
                          ? "var(--status-positive)"
                          : b.low >= 5
                            ? "var(--status-warning)"
                            : b.low >= 2
                              ? "var(--status-positive)"
                              : "var(--text-faint)";
                      return <Cell key={i} fill={c} opacity={b.count > 0 ? 1 : 0.15} />;
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>

            {/* Market Coverage (donut chart) */}
            <Panel
              title="Market Coverage"
              icon={<Globe className="w-4 h-4 text-[var(--platform-polymarket)]" />}
              rightElement={
                <span className="text-xs text-[var(--text-secondary)]">
                  By domain
                </span>
              }
            >
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={data!.marketCoverage}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, percent }: any) =>
                      percent > 0.05 ? `${name} ${(percent * 100).toFixed(0)}%` : ""
                    }
                    labelLine={false}
                  >
                    {data!.marketCoverage.map((_: any, i: number) => {
                      const COLORS: Record<string, string> = {
                        Politics: "var(--status-positive)",
                        Sports: "var(--status-warning)",
                        Crypto: "var(--platform-polymarket)",
                        Economics: "var(--status-info)",
                        Entertainment: "var(--status-negative)",
                        Other: "var(--text-faint)",
                      };
                      return (
                        <Cell
                          key={i}
                          fill={COLORS[data!.marketCoverage[i].name] || "var(--text-faint)"}
                          stroke="transparent"
                        />
                      );
                    })}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="bg-[var(--surface-workspace)] border border-[var(--border-subtle)] rounded-lg p-3 shadow-lg">
                          <p className="text-xs font-semibold" style={{ color: payload[0].color }}>
                            {payload[0].name}
                          </p>
                          <p className="text-xs font-mono text-[var(--text-secondary)]">
                            {payload[0].value} markets
                          </p>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </Panel>
          </div>

          {/* ── Row 3: Profit Timeline (area chart) ──────────── */}
          <Panel
            title="Arb Profit Timeline"
            className="order-5"
            icon={<TrendingUp className="w-4 h-4 text-[var(--status-positive)]" />}
            rightElement={
              <span className="text-xs text-[var(--text-secondary)]">
                {range === "all" ? "All time" : range === "today" ? "Today" : `Last ${RANGE_OPTIONS.find(o => o.key === range)?.label ?? "30 days"}`}
              </span>
            }
          >
            <ResponsiveContainer width="100%" height={260} key={`profit-${range}`}>
              <AreaChart data={data!.profitTimeline}>
                <defs>
                  <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--status-positive)" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="var(--status-positive)" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                  tickFormatter={(val: string) => val.slice(5)}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "var(--status-positive)" }}
                  tickFormatter={(v: number) => `$${v}`}
                />
                <Tooltip
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-[var(--surface-workspace)] border border-[var(--border-subtle)] rounded-lg p-3 shadow-lg">
                        <p className="text-xs text-[var(--text-secondary)]">{payload[0]?.payload?.time}</p>
                        <p className="text-xs font-mono text-[var(--status-positive)]">
                          {fmtUsd(payload[0].value)}
                        </p>
                      </div>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="profit"
                  name="Profit"
                  stroke="var(--status-positive)"
                  strokeWidth={2}
                  fill="url(#profitGrad)"
                  connectNulls
                />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* ── Row 4: Lifecycle Funnel ─────────────────────── */}
          <Panel
            title="Arb Lifecycle Funnel"
            icon={<Layers className="w-4 h-4 text-[var(--status-warning)]" />}
            rightElement={
              <span className="text-xs text-[var(--text-secondary)]">
                Found → Active → Recurring → Vanished → Expired
              </span>
            }
          >
            <div className="space-y-3">
              {(() => {
                const funnel = data!.lifecycleFunnel;
                const stages = [
                  { label: "Found", value: funnel.found, color: "var(--status-positive)", tooltip: "Total unique arb opportunities detected across scans in this period. Each market and outcome pair counts once per scan where net ROI is positive." },
                  { label: "Active", value: funnel.active, color: "var(--status-warning)", tooltip: "Arb episodes currently open: the most recent scan still shows positive net ROI. These are live right now." },
                  { label: "Recurring", value: funnel.recurring, color: "var(--platform-polymarket)", tooltip: "The same arb opportunity appeared, vanished, and then reappeared in separate episodes during this period." },
                  { label: "Vanished", value: funnel.vanished, color: "var(--status-negative)", tooltip: "Arb episodes that closed because the spread disappeared and net ROI fell to zero or below before market expiry." },
                  { label: "Expired", value: funnel.expired, color: "var(--text-faint)", tooltip: "Arb episodes that closed because the underlying market expired or settled, rather than because the spread disappeared." },
                ];
                const maxVal = Math.max(...stages.map((s) => s.value), 1);
                return stages.map((stage) => (
                  <div key={stage.label} className="flex items-center gap-3 cursor-help" title={stage.tooltip}>
                    <span className="text-xs font-medium w-20 text-[var(--text-secondary)] text-right shrink-0">
                      {stage.label}
                    </span>
                    <div className="flex-1 bg-[var(--surface-workspace)] rounded-full overflow-hidden" style={{ height: 24 }}>
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.max((stage.value / maxVal) * 100, stage.value > 0 ? 2 : 0)}%`,
                          backgroundColor: stage.color,
                        }}
                      />
                    </div>
                    <span className="text-xs font-mono font-semibold w-12 text-right shrink-0" style={{ color: stage.color }}>
                      {stage.value.toLocaleString()}
                    </span>
                  </div>
                ));
              })()}
            </div>
          </Panel>

          {/* ── Row 4b: Arb Episode Lifecycle (durable vs phantom) ── */}
          <Panel
            title="Arb Episode Stats"
            icon={<Clock className="w-4 h-4 text-[var(--status-positive)]" />}
            rightElement={
              <span className="text-xs text-[var(--text-secondary)]">
                Durable (≥5m) vs phantom (&lt;1m) episodes
              </span>
            }
          >
            <LifecycleStatsPanel
              days={range === "today" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 365}
            />
          </Panel>

          {/* ── Row 4c: Arb Type Breakdown ─────────────────── */}
          <Panel
            title="Arb Type Breakdown"
            icon={<Layers className="w-4 h-4 text-[var(--status-info)]" />}
            rightElement={
              <span className="text-xs text-[var(--text-secondary)]">
                Count & profit by type · Net of fees
              </span>
            }
          >
            {(!data!.arbTypeBreakdown || data!.arbTypeBreakdown.length === 0) ? (
              <EmptyState message="No arb type data in this period." />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(() => {
                  const TYPE_META: Record<string, { label: string; color: string; desc: string }> = {
                    cross: { label: 'Cross Arb', color: 'var(--status-info)', desc: 'YES+YES across platforms' },
                    direct: { label: 'Direct Arb', color: 'var(--status-positive)', desc: 'YES+NO same outcome' },
                    internal: { label: 'Internal Arb', color: 'var(--platform-polymarket)', desc: 'YES+YES same platform' },
                    unknown: { label: 'Unknown', color: 'var(--text-faint)', desc: 'Unclassified' },
                  };
                  const types = ['cross', 'direct', 'internal'];
                  return types.map((t) => {
                    const item = data!.arbTypeBreakdown.find((a) => a.type === t);
                    const meta = TYPE_META[t] ?? TYPE_META.unknown;
                    const count = item?.count ?? 0;
                    const profit = item?.totalProfit ?? 0;
                    const avgRoi = item?.avgRoi ?? 0;
                    return (
                      <div
                        key={t}
                        className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] p-3 space-y-2"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
                            style={{
                              backgroundColor: `${meta.color}20`,
                              color: meta.color,
                              border: `1px solid ${meta.color}40`,
                            }}
                          >
                            {meta.label}
                          </span>
                        </div>
                        <div className="text-xs text-[var(--text-faint)]">{meta.desc}</div>
                        <div className="flex items-baseline justify-between pt-1">
                          <div>
                            <div className="text-lg font-bold" style={{ color: meta.color }}>
                              {count.toLocaleString()}
                            </div>
                            <div className="text-[10px] text-[var(--text-faint)]">scans</div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-mono font-semibold" style={{ color: count > 0 ? 'var(--status-warning)' : 'var(--text-faint)' }}>
                              {count > 0 ? fmtUsd(profit) : '—'}
                            </div>
                            <div className="text-[10px] text-[var(--text-faint)]">
                              {count > 0 ? `avg ${fmtPct(avgRoi)}` : 'no data'}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </Panel>

          {/* ── Row 3: Top Active Arbs Table ───────────────── */}
          <Panel
            title="Top Active Arbs"
            className="order-3"
            icon={<TrendingUp className="w-4 h-4 text-[var(--status-warning)]" />}
            rightElement={
              <span className="text-xs text-[var(--text-secondary)]">
                Live · Sorted by ROI ↓ · Click to open scan
              </span>
            }
          >
            {data!.topActiveArbs.length === 0 ? (
              <EmptyState message="No active arbitrage opportunities in this period." />
            ) : (
              <div className="overflow-x-auto" data-testid="dashboard-top-arbs-scroll">
                <table className="w-full min-w-[800px] text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] bg-[var(--surface-workspace)]">
                      <th data-testid="dashboard-top-arb-market-header" className="sticky left-0 z-20 bg-[var(--surface-workspace)] px-3 py-2 text-left text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                        Market
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                        Strategy
                      </th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                        ROI
                      </th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                        Profit
                      </th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                        Arbs
                      </th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                        Scanned
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.topActiveArbs.map((arb) => {
                      const roiColor =
                        arb.best_roi_pct >= 5
                          ? "text-[var(--status-positive)]"
                          : arb.best_roi_pct >= 0
                            ? "text-[var(--status-warning)]"
                            : "text-[var(--status-negative)]";
                      return (
                        <tr
                          key={arb.id}
                          className="border-b border-[var(--border-subtle)] hover:bg-[var(--surface-workspace)]/50 transition-colors cursor-pointer"
                          onClick={() =>
                            (window.location.href = `/?view=scan&id=${encodeURIComponent(arb.market_id)}`)
                          }
                          title="Click to open market scan"
                        >
                          <td
                            data-testid="dashboard-top-arb-market-cell"
                            className="sticky left-0 z-10 bg-[var(--surface-panel)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] truncate max-w-[200px]"
                            title={arb.market_title || arb.market_id}
                          >
                            {arb.market_title || arb.market_id}
                          </td>
                          <td className="px-3 py-2 text-xs truncate max-w-[200px]" title={arb.strategy}>
                            <CompactStrategyDisplay strategy={arb.strategy} />
                          </td>
                          <td className={`px-3 py-2 text-right text-xs font-mono font-semibold ${roiColor}`}>
                            {fmtPct(arb.best_roi_pct)}
                          </td>
                          <td className="px-3 py-2 text-right text-xs font-mono text-[var(--status-warning)]">
                            {fmtUsd(arb.best_profit)}
                          </td>
                          <td className="px-3 py-2 text-right text-xs font-mono text-[var(--status-positive)]">
                            {arb.positive_arb_count}
                          </td>
                          <td className="px-3 py-2 text-right text-xs text-[var(--text-secondary)] font-mono whitespace-nowrap">
                            {fmtTime(arb.scanned_at)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      {/* Footer note */}
      {hasData && (
        <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
          <span>All values net of fees</span>
          <span>
            Data range: {RANGE_OPTIONS.find((r) => r.key === range)?.label}
          </span>
        </div>
      )}
    </div>
  );
}

// ── KPI Card ─────────────────────────────────────────────────────
function KPICard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3 space-y-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] text-[var(--text-secondary)]">{label}</span>
      </div>
      <div className="text-lg font-bold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
