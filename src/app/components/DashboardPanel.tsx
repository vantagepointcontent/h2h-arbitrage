"use client";

import { Activity, Heart, TrendingUp, Clock, AlertTriangle, CheckCircle } from "lucide-react";
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

export function DashboardPanel() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="w-5 h-5 text-[#5DBE81]" />
          Dashboard
        </h2>
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border ${healthBg}`}>
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
          icon=<TrendingUp className="w-4 h-4 text-[#5DBE81]" />
          label="Total Markets"
          value={stats.totalMarkets.toString()}
          color="#5DBE81"
        />
        <StatCard
          icon=<Heart className="w-4 h-4 text-[#ef4444]" />
          label="Arb Opportunities"
          value={stats.arbOpportunities.toString()}
          color="#ef4444"
        />
        <StatCard
          icon=<TrendingUp className="w-4 h-4 text-[#facc15]" />
          label="Total Profit"
          value={formatCurrency(stats.totalProfit)}
          color="#facc15"
        />
        <StatCard
          icon=<Clock className="w-4 h-4 text-[#5E6875]" />
          label="Avg ROI"
          value={formatPercent(stats.avgRoi)}
          color="#5E6875"
        />
      </div>

      {/* Uptime */}
      <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-[#5E6875]">Server Uptime</span>
          <span className="text-xs font-mono text-[#FFFFFF]">
            {Math.floor(stats.uptime / 3600)}h {(Math.floor(stats.uptime / 60) % 60)}m
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
      <div className="flex items-center gap-1.5">{icon}<span className="text-[10px] text-[#5E6875]">{label}</span></div>
      <div className="text-lg font-bold" style={{ color }}>{value}</div>
    </div>
  );
}
