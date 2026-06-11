"use client";

import {
  Activity,
  Heart,
  TrendingUp,
  Clock,
  AlertTriangle,
  CheckCircle,
  BarChart3,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { useEffect, useState } from "react";

interface DashboardStats {
  totalMarkets: number;
  totalProfit: number;
  arbOpportunities: number;
  avgRoi: number;
  lastScan: string | null;
  health: "healthy" | "degraded" | "unhealthy";
  uptime: number;
}

interface ScanHistoryEntry {
  scanTimestamp: string;
  marketId: string;
  totalProfit: number;
  bestRoiPct: number;
  positiveArbCount: number;
  matchedCount: number;
}

export function DashboardPanel() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<ScanHistoryEntry[]>([]);
  const [histLoading, setHistLoading] = useState(true);

  // Main stats
  useEffect(() => {
    fetch("/api/healthz", { cache: "no-store" })
      .then((r) => r.json())
      .then((h) => {
        fetch("/api/saved-markets", { cache: "no-store" })
          .then((r) => r.json())
          .then((d) => {
            const markets = d.markets || [];
            const totalProfit = markets.reduce(
              (s: number, m: any) => s + (m.lastScanResult?.totalProfit ?? 0),
              0
            );
            const arbOpps = markets.filter(
              (m: any) => (m.lastScanResult?.positiveArbCount ?? 0) > 0
            ).length;
            const avgRoi =
              markets.length > 0
                ? markets.reduce(
                    (s: number, m: any) => s + (m.lastScanResult?.bestRoiPct ?? 0),
                    0
                  ) / markets.length
                : 0;

            setStats({
              totalMarkets: markets.length,
              totalProfit,
              arbOpportunities: arbOpps,
              avgRoi,
              lastScan: h.lastScanAt,
              health: h.status,
              uptime: h.uptimeSeconds ?? 0,
            });
            setLoading(false);
          });
      })
      .catch(() => setLoading(false));
  }, []);

  // Scan history
  useEffect(() => {
    fetch("/api/scan-history?limit=100", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setHistory(d.history || []);
        setHistLoading(false);
      })
      .catch(() => setHistLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="py-20 text-center text-sm text-[#5E6875]">
        <Activity className="w-6 h-6 animate-spin mx-auto mb-3" />
        Loading dashboard...
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="py-20 text-center text-sm text-[#ef4444]">
        <AlertTriangle className="w-6 h-6 mx-auto mb-3" />
        Failed to load dashboard data.
      </div>
    );
  }

  const formatCurrency = (n: number) =>
    n >= 1000
      ? `$${(n / 1000).toFixed(1)}k`
      : `$${n.toFixed(0)}`;

  const formatPercent = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

  const healthColor =
    stats.health === "healthy"
      ? "text-[#5DBE81]"
      : stats.health === "degraded"
        ? "text-[#facc15]"
        : "text-[#ef4444]";

  const healthBg =
    stats.health === "healthy"
      ? "bg-[#5DBE81]/10 border-[#5DBE81]/20"
      : stats.health === "degraded"
        ? "bg-[#facc15]/10 border-[#facc15]/20"
        : "bg-[#ef4444]/10 border-[#ef4444]/20";

  // ── Scan history derived values ────────────────────────────────
  const hasHistory = !histLoading && history.length > 0;

  // Avg spread (mean of bestRoiPct across all history entries)
  const avgSpread = hasHistory
    ? history.reduce((s, e) => s + e.bestRoiPct, 0) / history.length
    : 0;

  // Top 5 best scans by ROI
  const top5Scans = hasHistory
    ? [...history]
        .sort((a, b) => b.bestRoiPct - a.bestRoiPct)
        .slice(0, 5)
    : [];

  // Bar chart: last 40 scans (most recent first), normalized to max ROI
  const chartBars = hasHistory
    ? [...history].slice(0, 40)
    : [];
  const maxRoiInChart = chartBars.length
    ? Math.max(...chartBars.map((b) => Math.abs(b.bestRoiPct)), 1)
    : 1;

  const barColor = (roi: number) => {
    if (roi >= 5) return "#5DBE81";
    if (roi >= 1) return "#facc15";
    if (roi > 0) return "#5DBE81";
    return "#ef4444";
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="w-5 h-5 text-[#5DBE81]" />
          Dashboard
        </h2>
        <div
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border ${healthBg}`}
        >
          {stats.health === "healthy" ? (
            <CheckCircle className={`w-3.5 h-3.5 ${healthColor}`} />
          ) : (
            <AlertTriangle className={`w-3.5 h-3.5 ${healthColor}`} />
          )}
          <span className={`text-xs font-medium capitalize ${healthColor}`}>
            {stats.health}
          </span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={<TrendingUp className="w-4 h-4 text-[#5DBE81]" />}
          label="Total Markets"
          value={stats.totalMarkets.toString()}
          color="#5DBE81"
        />
        <StatCard
          icon={<Heart className="w-4 h-4 text-[#ef4444]" />}
          label="Arb Opportunities"
          value={stats.arbOpportunities.toString()}
          color="#ef4444"
        />
        <StatCard
          icon={<TrendingUp className="w-4 h-4 text-[#facc15]" />}
          label="Total Profit"
          value={formatCurrency(stats.totalProfit)}
          color="#facc15"
        />
        <StatCard
          icon={<Clock className="w-4 h-4 text-[#5E6875]" />}
          label="Avg ROI"
          value={formatPercent(stats.avgRoi)}
          color="#5E6875"
        />
      </div>

      {/* ── Scan History Bar Chart ─────────────────────────────── */}
      <div className="rounded-lg border border-[#182533] bg-[#17212B] p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4 text-[#5DBE81]" />
            Scan History
          </h3>
          <span className="text-xs text-[#5E6875]">
            {chartBars.length} scans · last {Math.round(avgSpread, 1)}% avg ROI
          </span>
        </div>

        {!hasHistory && (
          <div className="text-xs text-[#5E6875] text-center py-6">
            No scan history yet — run a scan to populate the chart.
          </div>
        )}

        {hasHistory && (
          <>
            {/* Zero baseline label */}
            <div className="relative h-32 mb-1">
              {/* Baseline line */}
              <div className="absolute left-0 right-0 top-1/2 border-t border-dashed border-[#182533]" />

              {/* Bars */}
              <div className="absolute inset-0 flex items-end gap-px">
                {chartBars.map((bar, i) => {
                  const absRoi = Math.abs(bar.bestRoiPct);
                  const heightPct = Math.max((absRoi / maxRoiInChart) * 100, 2);
                  const isPositive = bar.bestRoiPct >= 0;
                  const color = barColor(bar.bestRoiPct);

                  return (
                    <div
                      key={i}
                      className="flex-1 min-w-[2px] flex flex-col justify-end group relative"
                      style={{ height: "100%" }}
                      title={`${new Date(bar.scanTimestamp).toLocaleTimeString()} · ${formatPercent(bar.bestRoiPct)} · ${bar.positiveArbCount} arbs`}
                    >
                      {/* Bar fills from center outward */}
                      <div
                        className="w-full rounded-sm transition-all duration-200 hover:brightness-125"
                        style={{
                          height: `${heightPct}%`,
                          backgroundColor: color,
                          opacity: 0.85,
                          alignSelf: isPositive ? "flex-start" : "flex-end",
                          marginTop: isPositive ? "auto" : 0,
                          marginBottom: isPositive ? 0 : "auto",
                        }}
                      />
                      {/* Tooltip on hover */}
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-[#0E1621] border border-[#182533] text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-10">
                        <div className="font-mono text-white">{formatPercent(bar.bestRoiPct)}</div>
                        <div className="text-[#5E6875]">{bar.positiveArbCount} arbs</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Scale labels */}
            <div className="flex justify-between text-[10px] text-[#5E6875] font-mono mt-1">
              <span>-{maxRoiInChart.toFixed(1)}%</span>
              <span>0%</span>
              <span>+{maxRoiInChart.toFixed(1)}%</span>
            </div>
          </>
        )}
      </div>

      {/* ── Best Arb Trend ─────────────────────────────────────── */}
      {hasHistory && top5Scans.length > 0 && (
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-4">
          <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
            <TrendingUp className="w-4 h-4 text-[#facc15]" />
            Best Arb Trend
          </h3>
          <div className="space-y-2">
            {top5Scans.map((scan, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-1.5 px-2 rounded-md bg-[#0E1621] border border-[#182533]"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                    style={{
                      backgroundColor: i === 0 ? "#facc15" : i < 3 ? "#5DBE81" : "#5E6875",
                      color: i === 0 ? "#0E1621" : "#fff",
                    }}
                  >
                    {i + 1}
                  </span>
                  <div>
                    <div className="text-xs font-medium text-white">
                      {scan.bestRoiPct >= 1 ? "🟢" : scan.bestRoiPct > 0 ? "🟡" : "🔴"}{" "}
                      {formatPercent(scan.bestRoiPct)}
                    </div>
                    <div className="text-[10px] text-[#5E6875]">
                      {new Date(scan.scanTimestamp).toLocaleString()} · {scan.positiveArbCount}{" "}
                      arbs · {scan.matchedCount} matched
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs font-mono text-[#5DBE81]">
                    {formatCurrency(scan.totalProfit)}
                  </div>
                  <div className="text-[10px] text-[#5E6875]">profit</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Avg Spread ─────────────────────────────────────────── */}
      {hasHistory && (
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-4">
          <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
            <BarChart3 className="w-4 h-4 text-[#facc15]" />
            Avg Spread
          </h3>
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center">
              <div className="text-2xl font-bold text-[#5DBE81]">
                {avgSpread.toFixed(1)}%
              </div>
              <div className="text-[10px] text-[#5E6875] mt-1">Mean ROI</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-[#facc15]">
                {history
                  .reduce((s, e) => s + e.totalProfit, 0)
                  .toFixed(0)}
              </div>
              <div className="text-[10px] text-[#5E6875] mt-1">Total Profit ($)</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-[#FFFFFF]">
                {history.length}
              </div>
              <div className="text-[10px] text-[#5E6875] mt-1">Scans</div>
            </div>
          </div>
          {/* Spread distribution mini chart */}
          <div className="mt-3 flex items-end gap-0.5 h-8">
            {(() => {
              const buckets = [
                { label: "<1%", range: [-Infinity, 1], count: 0 },
                { label: "1-3%", range: [1, 3], count: 0 },
                { label: "3-5%", range: [3, 5], count: 0 },
                { label: "5-10%", range: [5, 10], count: 0 },
                { label: ">10%", range: [10, Infinity], count: 0 },
              ];
              history.forEach((e) => {
                const roi = e.bestRoiPct;
                for (let bi = 0; bi < buckets.length; bi++) {
                  const [lo, hi] = buckets[bi].range;
                  if (roi >= lo && roi < hi) {
                    buckets[bi].count++;
                    break;
                  }
                }
              });
              const maxBucket = Math.max(...buckets.map((b) => b.count), 1);
              return buckets.map((b, i) => (
                <div
                  key={i}
                  className="flex-1 flex flex-col items-center justify-end h-full"
                >
                  <div
                    className="w-full rounded-t-sm transition-all"
                    style={{
                      height: `${Math.max((b.count / maxBucket) * 100, 4)}%`,
                      backgroundColor:
                        i === 0
                          ? "#5E6875"
                          : i === 1
                            ? "#5DBE81"
                            : i === 2
                              ? "#facc15"
                              : i === 3
                                ? "#5DBE81"
                                : "#5DBE81",
                      opacity: b.count > 0 ? 0.85 : 0.2,
                    }}
                  />
                </div>
              ));
            })()}
          </div>
          <div className="flex justify-between text-[9px] text-[#5E6875] mt-1 font-mono">
            <span>&lt;1%</span>
            <span>1-3%</span>
            <span>3-5%</span>
            <span>5-10%</span>
            <span>&gt;10%</span>
          </div>
        </div>
      )}

      {/* Uptime */}
      <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-[#5E6875]">Server Uptime</span>
          <span className="text-xs font-mono text-[#FFFFFF]">
            {Math.floor(stats.uptime / 3600)}h{" "}
            {(Math.floor(stats.uptime / 60) % 60)}m
          </span>
        </div>
      </div>

      {/* Last scan */}
      {stats.lastScan && (
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#5E6875]">Last Auto-Scan</span>
            <span className="text-xs font-mono text-[#FFFFFF]">
              {new Date(stats.lastScan).toLocaleString()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
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
    <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3 space-y-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] text-[#5E6875]">{label}</span>
      </div>
      <div className="text-lg font-bold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
