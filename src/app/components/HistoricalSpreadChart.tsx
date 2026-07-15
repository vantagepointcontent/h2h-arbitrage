"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { getSpreads, getSpreadsForOutcome, getUniqueArtists, TIME_RANGES, TimeRange, SpreadPoint } from "@/lib/spreadHistory";
import { Clock, BarChart3, ZoomIn } from "lucide-react";

interface Props {
  marketId: string;
  /** Current outcome names from the scan result (for toggle UI) */
  outcomeArtists?: string[];
  /** Current average ROI for live indicator (average mode) */
  currentAvgRoi?: number;
  /** Current best ROI for live indicator (per-outcome mode) */
  currentRoi?: number;
}

type ViewMode = "average" | string; // "average" or an outcome artist name

export function HistoricalSpreadChart({ marketId, outcomeArtists, currentAvgRoi, currentRoi }: Props) {
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");
  const [data, setData] = useState<SpreadPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("average");
  const [storedArtists, setStoredArtists] = useState<string[]>([]);

  // Fetch unique artists from IndexedDB (for historical outcomes that may not be in current scan)
  useEffect(() => {
    let cancelled = false;
    getUniqueArtists(marketId)
      .then((artists) => {
        if (!cancelled) setStoredArtists(artists);
      })
      .catch(() => {
        if (!cancelled) setStoredArtists([]);
      });
    return () => { cancelled = true; };
  }, [marketId]);

  // Merge current scan outcomes with stored historical outcomes
  const availableArtists = useMemo(() => {
    const merged = new Set<string>();
    outcomeArtists?.forEach((a) => merged.add(a));
    storedArtists.forEach((a) => merged.add(a));
    return [...merged].sort();
  }, [outcomeArtists, storedArtists]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const now = Date.now();
    const from = now - TIME_RANGES[timeRange];
    if (viewMode === "average") {
      // Fetch all points and group by timestamp to compute average
      const points = await getSpreads(marketId, from, now);
      setData(points);
    } else {
      // Fetch only for the selected outcome
      const points = await getSpreadsForOutcome(marketId, viewMode, from, now);
      setData(points);
    }
    setLoading(false);
  }, [marketId, timeRange, viewMode]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // For "average" mode: group points by timestamp and compute average spread + ROI
  const chartData = useMemo(() => {
    if (viewMode !== "average") {
      // Per-outcome: just sample
      const maxPoints = 200;
      if (data.length <= maxPoints) return data;
      const step = Math.ceil(data.length / maxPoints);
      return data.filter((_, i) => i % step === 0 || i === data.length - 1);
    }

    // Average mode: group by timestamp, compute mean spread and ROI
    const byTs = new Map<number, SpreadPoint[]>();
    for (const p of data) {
      const arr = byTs.get(p.ts) ?? [];
      arr.push(p);
      byTs.set(p.ts, arr);
    }

    const averaged: SpreadPoint[] = [];
    for (const [ts, pts] of byTs) {
      const avgSpread = pts.reduce((s, p) => s + p.spread, 0) / pts.length;
      const avgRoi = pts.reduce((s, p) => s + p.roiPct, 0) / pts.length;
      averaged.push({
        ...pts[0],
        ts,
        spread: avgSpread,
        roiPct: avgRoi,
        outcomeArtist: "__average__",
      });
    }
    averaged.sort((a, b) => a.ts - b.ts);

    // Sample to max 200 points
    const maxPoints = 200;
    if (averaged.length <= maxPoints) return averaged;
    const step = Math.ceil(averaged.length / maxPoints);
    return averaged.filter((_, i) => i % step === 0 || i === averaged.length - 1);
  }, [data, viewMode]);

  const formatTooltip = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

  const headerLabel = viewMode === "average" ? "Market Average" : viewMode;

  return (
    <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#182533]">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-[#5DBE81]" />
            <span className="text-sm font-semibold">Arbitrage History</span>
            <span className="text-[11px] text-[#8A9BA8]">— {headerLabel}</span>
          </div>
          <div className="flex items-center gap-1">
            {(Object.keys(TIME_RANGES) as TimeRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  timeRange === range
                    ? "bg-[#5DBE81]/15 text-[#5DBE81] border border-[#5DBE81]/30"
                    : "text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-[#182533]"
                }`}
              >
                {range}
              </button>
            ))}
          </div>
        </div>

        {/* Toggle row: Market Average + per-outcome tabs */}
        {availableArtists.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setViewMode("average")}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                viewMode === "average"
                  ? "bg-[#5DBE81]/15 text-[#5DBE81] border border-[#5DBE81]/30"
                  : "text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-[#182533] border border-transparent"
              }`}
            >
              Market Average
            </button>
            {availableArtists.map((artist) => (
              <button
                key={artist}
                onClick={() => setViewMode(artist)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors max-w-[180px] truncate ${
                  viewMode === artist
                    ? "bg-[#5DBE81]/15 text-[#5DBE81] border border-[#5DBE81]/30"
                    : "text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-[#182533] border border-transparent"
                }`}
                title={artist}
              >
                {artist}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Chart area */}
      <div className="relative" style={{ height: 240 }}>
        {loading && data.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-[#8A9BA8] text-sm">
            Loading...
          </div>
        ) : data.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-[#8A9BA8] text-sm gap-2">
            <Clock className="w-5 h-5" />
            <span>No historical data yet</span>
            <span className="text-[11px] text-[#8A9BA8]">Samples collected during active scans</span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 8, right: 12, left: 4, bottom: 4 }}
            >
              <CartesianGrid stroke="#182533" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(ts: number) => {
                  const d = new Date(ts);
                  if (timeRange === "24h") {
                    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  }
                  return d.toLocaleDateString([], { month: "short", day: "numeric" });
                }}
                tick={{ fontSize: 10, fill: "#5E6875" }}
                axisLine={{ stroke: "#232E3C" }}
                tickLine={false}
              />
              <YAxis
                domain={['auto', 'auto']}
                tickFormatter={formatTooltip}
                tick={{ fontSize: 10, fill: "#5E6875" }}
                axisLine={{ stroke: "#232E3C" }}
                tickLine={false}
                width={48}
              />
              <Tooltip
                content={((props: { active?: boolean; payload?: Array<{ payload: unknown }> }) => {
                  if (!props?.active || !props?.payload?.length) return null;
                  const p = props.payload[0]?.payload as SpreadPoint;
                  return (
                    <div className="rounded-lg border border-[#232E3C] bg-[#17212B] p-3 shadow-xl text-xs space-y-1">
                      <div className="text-[#8A9BA8] text-[10px]">
                        {new Date(p.ts).toLocaleString()}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[#5DBE81] font-bold">
                          {formatTooltip(p.roiPct)}
                        </span>
                        <span className="text-[#8A9BA8]">{p.strategy}</span>
                      </div>
                      {viewMode === "average" ? (
                        <div className="text-[#8A9BA8] text-[10px]">
                          Average across all outcomes
                        </div>
                      ) : (
                        <div className="text-[#8A9BA8] text-[10px]">
                          {p.outcomeArtist}
                        </div>
                      )}
                      <div className="text-[#8A9BA8] text-[10px] flex items-center gap-1.5">
                        <span className="inline-flex items-center gap-0.5">
                          <img src="/kalshi-icon.png" alt="Kalshi" className="w-3 h-3 rounded-sm inline" /> {p.kalshiYesBid.toFixed(3)} / {p.kalshiYesAsk.toFixed(3)}
                        </span>
                        <span className="inline-flex items-center gap-0.5">
                          <img src="/polymarket-icon.png" alt="Polymarket" className="w-3 h-3 rounded-sm inline" /> {p.pmYesBid.toFixed(3)} / {p.pmYesAsk.toFixed(3)}
                        </span>
                      </div>
                    </div>
                  );
                }) as any}
              />
              {/* Zero ROI reference line */}
              <ReferenceLine y={0} stroke="#232E3C" strokeDasharray="4 2" />

              {/* ROI area — uses roiPct (net arbitrage ROI) not raw spread,
                  so the chart matches the per-row ROI shown in the outcome table */}
              <Area
                type="monotone"
                dataKey="roiPct"
                stroke="#5DBE81"
                strokeWidth={1.5}
                fill="url(#positiveGradient)"
                connectNulls
              />

              <defs>
                <linearGradient id="positiveGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5DBE81" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#5DBE81" stopOpacity={0.02} />
                </linearGradient>
              </defs>
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Footer stats */}
      {data.length > 0 && (
        <div className="px-4 py-2 border-t border-[#182533] flex items-center justify-between text-[11px] text-[#8A9BA8]">
          <div className="flex items-center gap-3">
            <span>{chartData.length} samples</span>
            <span>·</span>
            <span>
              Best: <span className="text-[#5DBE81] font-bold">
                {(+Math.max(...chartData.map(d => d.roiPct)).toFixed(2))}%
              </span>
            </span>
            <span>
              Avg: <span className="text-[#FFFFFF] font-mono">
                {(chartData.reduce((s, d) => s + d.roiPct, 0) / chartData.length).toFixed(2)}%
              </span>
            </span>
          </div>
          {currentAvgRoi !== undefined && viewMode === "average" && (
            <div className="flex items-center gap-1.5">
              <ZoomIn className="w-3 h-3" />
              <span>Live ROI:</span>
              <span className={`font-bold ${currentAvgRoi > 0 ? "text-[#5DBE81]" : "text-[#8A9BA8]"}`}>
                {currentAvgRoi > 0 ? "+" : ""}{currentAvgRoi.toFixed(2)}%
              </span>
            </div>
          )}
          {currentRoi !== undefined && viewMode !== "average" && (
            <div className="flex items-center gap-1.5">
              <ZoomIn className="w-3 h-3" />
              <span>Live ROI:</span>
              <span className={`font-bold ${currentRoi > 0 ? "text-[#5DBE81]" : "text-[#8A9BA8]"}`}>
                {currentRoi > 0 ? "+" : ""}{currentRoi.toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
