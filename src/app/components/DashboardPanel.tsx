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
} from "lucide-react";
import { useEffect, useState, useCallback } from "react";
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
  best_roi_pct: number;
  best_profit: number;
  strategy: string;
  positive_arb_count: number;
  scanned_at: string;
}

interface DashboardData {
  kpis: KPISummary;
  scansPerDay: ScanPerDay[];
  roiDistribution: ROIBucket[];
  timeline: TimelinePoint[];
  topActiveArbs: ActiveArb[];
  range: string;
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
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  rightElement?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[#182533] bg-[#17212B] p-4">
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
    <div className="py-16 text-center text-sm text-[#5E6875]">
      <Layers className="w-8 h-8 mx-auto mb-2 opacity-40" />
      {message}
    </div>
  );
}

// ── Custom tooltip for charts ────────────────────────────────────
const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#0E1621] border border-[#182533] rounded-lg p-3 shadow-lg">
      <p className="text-xs text-[#8A9BA8] mb-1">{label}</p>
      {payload.map((entry: any, i: number) => (
        <p key={i} className="text-xs font-mono" style={{ color: entry.color }}>
          {entry.name}: {entry.value}
        </p>
      ))}
    </div>
  );
};

// ── Main Component ───────────────────────────────────────────────
export function DashboardPanel() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [range, setRange] = useState<RangeKey>("30d");
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/dashboard/stats?range=${range}`,
        { cache: "no-store" }
      );
      const json = await res.json();
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
      <div className="py-20 text-center text-sm text-[#5E6875]">
        <Activity className="w-6 h-6 animate-spin mx-auto mb-3" />
        Loading dashboard…
      </div>
    );
  }

  if (!data && error) {
    return (
      <div className="py-20 text-center text-sm text-[#ef4444]">
        <AlertTriangle className="w-6 h-6 mx-auto mb-3" />
        {error}
      </div>
    );
  }

  const kpis = data!.kpis;
  const hasData = kpis.totalScans > 0;

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="w-5 h-5 text-[#5DBE81]" />
          Dashboard
        </h2>
        <div className="flex items-center gap-3">
          {/* Date range selector */}
          <div className="flex items-center gap-1 bg-[#182533] rounded-lg p-0.5">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                onClick={() => setRange(opt.key)}
                className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                  range === opt.key
                    ? "bg-[#5DBE81]/20 text-[#5DBE81]"
                    : "text-[#8A9BA8] hover:text-[#FFFFFF]"
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
                ? "bg-[#5DBE81]/10 text-[#5DBE81] border-[#5DBE81]/30"
                : "bg-[#182533] text-[#8A9BA8] border-[#182533] hover:text-[#FFFFFF]"
            }`}
            title="Auto-refresh every 60s"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${autoRefresh ? "animate-spin" : ""}`} />
            {autoRefresh ? "On" : "Off"}
          </button>
        </div>
      </div>

      {/* ── 5 KPI Cards ──────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KPICard
          icon={<Zap className="w-4 h-4" />}
          label="Total Arbs Found"
          value={kpis.totalArbsFound.toLocaleString()}
          color="#5DBE81"
        />
        <KPICard
          icon={<Eye className="w-4 h-4" />}
          label="Active Arbs Now"
          value={kpis.activeArbs.toLocaleString()}
          color="#facc15"
        />
        <KPICard
          icon={<BarChart3 className="w-4 h-4" />}
          label="Total Scans"
          value={kpis.totalScans.toLocaleString()}
          color="#FFFFFF"
        />
        <KPICard
          icon={<TrendingUp className="w-4 h-4" />}
          label="Avg ROI"
          value={fmtPct(kpis.avgRoi)}
          color={kpis.avgRoi > 0 ? "#5DBE81" : "#ef4444"}
        />
        <KPICard
          icon={<Globe className="w-4 h-4" />}
          label="Markets Tracked"
          value={kpis.marketsTracked.toString()}
          color="#a855f7"
        />
      </div>

      {!hasData ? (
        <EmptyState message="No scan data yet. Run a scan to populate the dashboard." />
      ) : (
        <>
          {/* ── Row 1: Timeline + Scans Per Day ──────────── */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* Arb Discovery Timeline (line chart) */}
            <Panel
              title="Arb Discovery Timeline"
              icon={<Activity className="w-4 h-4 text-[#5DBE81]" />}
              rightElement={
                <span className="text-xs text-[#8A9BA8]">
                  Scans &amp; ROI trend
                </span>
              }
            >
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={data!.timeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#182533" />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 10, fill: "#8A9BA8" }}
                    tickFormatter={(val: string) => val.slice(5)}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 10, fill: "#5DBE81" }}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 10, fill: "#facc15" }}
                    domain={[0, "dataMax"]}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ color: '#8A9BA8', fontSize: '11px' }} />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="scans"
                    name="Scans"
                    stroke="#5DBE81"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="avgRoi"
                    name="Avg ROI %"
                    stroke="#facc15"
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
              icon={<BarChart3 className="w-4 h-4 text-[#5DBE81]" />}
              rightElement={
                <span className="text-xs text-[#8A9BA8]">
                  Last 30 days
                </span>
              }
            >
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data!.scansPerDay}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#182533" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: "#8A9BA8" }}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 10, fill: "#8A9BA8" }} allowDecimals={false} />
                  <Tooltip
                    content={({ active, payload, label }: any) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="bg-[#0E1621] border border-[#182533] rounded-lg p-3 shadow-lg">
                          <p className="text-xs text-[#8A9BA8]">{fmtShortDate(label)}</p>
                          <p className="text-xs font-mono text-[#5DBE81]">
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
                            ? "#5DBE81"
                            : "#182533"
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          </div>

          {/* ── Row 2: ROI Histogram ───────────────────────── */}
          <Panel
            title="ROI Distribution"
            icon={<Target className="w-4 h-4 text-[#5DBE81]" />}
            rightElement={
              <span className="text-xs text-[#8A9BA8]">
                Net of fees
              </span>
            }
          >
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={data!.roiDistribution.map((b) => ({
                  ...b,
                  color:
                    b.low >= 10
                      ? "#5DBE81"
                      : b.low >= 5
                        ? "#facc15"
                        : b.low >= 2
                          ? "#5DBE81"
                          : "#5E6875",
                }))}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#182533" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "#8A9BA8" }}
                />
                <YAxis tick={{ fontSize: 10, fill: "#8A9BA8" }} allowDecimals={false} />
                <Tooltip
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-[#0E1621] border border-[#182533] rounded-lg p-3 shadow-lg">
                        <p className="text-xs text-[#8A9BA8]">
                          ROI {payload[0]?.payload?.label}
                        </p>
                        <p className="text-xs font-mono text-[#5DBE81]">
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
                        ? "#5DBE81"
                        : b.low >= 5
                          ? "#facc15"
                          : b.low >= 2
                            ? "#5DBE81"
                            : "#5E6875";
                    return <Cell key={i} fill={c} opacity={b.count > 0 ? 1 : 0.15} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          {/* ── Row 3: Top Active Arbs Table ───────────────── */}
          <Panel
            title="Top Active Arbs"
            icon={<TrendingUp className="w-4 h-4 text-[#facc15]" />}
            rightElement={
              <span className="text-xs text-[#8A9BA8]">
                Sorted by ROI ↓ · Click to open scan
              </span>
            }
          >
            {data!.topActiveArbs.length === 0 ? (
              <EmptyState message="No active arbitrage opportunities in this period." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#182533] bg-[#0E1621]">
                      <th className="px-3 py-2 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">
                        Market
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">
                        Strategy
                      </th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">
                        ROI
                      </th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">
                        Profit
                      </th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">
                        Arbs
                      </th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">
                        Scanned
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.topActiveArbs.map((arb) => {
                      const roiColor =
                        arb.best_roi_pct >= 5
                          ? "text-[#5DBE81]"
                          : arb.best_roi_pct >= 0
                            ? "text-[#facc15]"
                            : "text-[#ef4444]";
                      return (
                        <tr
                          key={arb.id}
                          className="border-b border-[#182533] hover:bg-[#0E1621]/50 transition-colors cursor-pointer"
                          onClick={() =>
                            (window.location.href = `/?view=scan&id=${encodeURIComponent(arb.market_id)}`)
                          }
                          title="Click to open market scan"
                        >
                          <td
                            className="px-3 py-2 text-xs font-medium text-[#FFFFFF] truncate max-w-[200px]"
                            title={arb.market_id}
                          >
                            {arb.market_id}
                          </td>
                          <td className="px-3 py-2 text-xs text-[#8A9BA8] truncate max-w-[200px]" title={arb.strategy}>
                            {arb.strategy || "—"}
                          </td>
                          <td className={`px-3 py-2 text-right text-xs font-mono font-semibold ${roiColor}`}>
                            {fmtPct(arb.best_roi_pct)}
                          </td>
                          <td className="px-3 py-2 text-right text-xs font-mono text-[#facc15]">
                            {fmtUsd(arb.best_profit)}
                          </td>
                          <td className="px-3 py-2 text-right text-xs font-mono text-[#5DBE81]">
                            {arb.positive_arb_count}
                          </td>
                          <td className="px-3 py-2 text-right text-xs text-[#5E6875] font-mono whitespace-nowrap">
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
        <div className="flex items-center justify-between text-xs text-[#8A9BA8]">
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
    <div className="rounded-xl border border-[#182533] bg-[#17212B] p-3 space-y-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] text-[#8A9BA8]">{label}</span>
      </div>
      <div className="text-lg font-bold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
