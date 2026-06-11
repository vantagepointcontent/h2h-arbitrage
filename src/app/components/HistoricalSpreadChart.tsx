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
import { getSpreads, TIME_RANGES, TimeRange, SpreadPoint } from "@/lib/spreadHistory";
import { Clock, BarChart3, ZoomIn } from "lucide-react";

interface Props {
  marketId: string;
  /** Current spread for live indicator */
  currentSpread?: number;
  currentRoi?: number;
}

export function HistoricalSpreadChart({ marketId, currentSpread, currentRoi }: Props) {
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");
  const [data, setData] = useState<SpreadPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const now = Date.now();
    const from = now - TIME_RANGES[timeRange];
    const points = await getSpreads(marketId, from, now);
    setData(points);
    setLoading(false);
  }, [marketId, timeRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Sample data to fit the chart width — avoid overcrowding
  const chartData = useMemo(() => {
    const maxPoints = 200;
    if (data.length <= maxPoints) return data;
    const step = Math.ceil(data.length / maxPoints);
    return data.filter((_, i) => i % step === 0 || i === data.length - 1);
  }, [data]);

  const formatTooltip = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

  return (
    <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#182533] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-[#5DBE81]" />
          <span className="text-sm font-semibold">Spread History</span>
        </div>
        <div className="flex items-center gap-1">
          {(Object.keys(TIME_RANGES) as TimeRange[]).map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                timeRange === range
                  ? "bg-[#5DBE81]/15 text-[#5DBE81] border border-[#5DBE81]/30"
                  : "text-[#5E6875] hover:text-[#FFFFFF] hover:bg-[#182533]"
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* Chart area */}
      <div className="relative" style={{ height: 240 }}>
        {loading && data.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-[#232E3C] text-sm">
            Loading...
          </div>
        ) : data.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-[#232E3C] text-sm gap-2">
            <Clock className="w-5 h-5" />
            <span>No historical data yet</span>
            <span className="text-[11px] text-[#232E3C]">Samples collected every 30s during active scans</span>
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
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0]?.payload as SpreadPoint;
                  return (
                    <div className="rounded-lg border border-[#232E3C] bg-[#17212B] p-3 shadow-xl text-xs space-y-1">
                      <div className="text-[#5E6875] text-[10px]">
                        {new Date(label).toLocaleString()}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[#5DBE81] font-bold">
                          {formatTooltip(p.spread)}
                        </span>
                        <span className="text-[#232E3C]">{p.strategy}</span>
                      </div>
                      <div className="text-[#5E6875] text-[10px]">
                        K: {p.kalshiYesBid.toFixed(3)} / {p.kalshiYesAsk.toFixed(3)}
                        {"  "}PM: {p.pmYesBid.toFixed(3)} / {p.pmYesAsk.toFixed(3)}
                      </div>
                      <div className="text-[#facc15] text-[10px]">
                        ROI: {p.roiPct.toFixed(2)}%
                      </div>
                    </div>
                  );
                }}
              />
              {/* Zero spread reference line */}
              <ReferenceLine y={0} stroke="#232E3C" strokeDasharray="4 2" />

              {/* Positive spread area (above zero) */}
              <Area
                type="monotone"
                dataKey="spread"
                stroke="#5DBE81"
                strokeWidth={1.5}
                fill="url(#positiveGradient)"
                connectNulls
              />

              {/* Negative spread area (below zero) */}
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
        <div className="px-4 py-2 border-t border-[#182533] flex items-center justify-between text-[11px] text-[#5E6875]">
          <div className="flex items-center gap-3">
            <span>{data.length} samples</span>
            <span>·</span>
            <span>
              Best: <span className="text-[#5DBE81] font-bold">
                {(+Math.max(...data.map(d => d.spread)).toFixed(2))}%
              </span>
            </span>
            <span>
              Avg: <span className="text-[#FFFFFF] font-mono">
                {(data.reduce((s, d) => s + d.spread, 0) / data.length).toFixed(2)}%
              </span>
            </span>
          </div>
          {currentSpread !== undefined && (
            <div className="flex items-center gap-1.5">
              <ZoomIn className="w-3 h-3" />
              <span>Live:</span>
              <span className={`font-bold ${currentSpread > 0 ? "text-[#5DBE81]" : "text-[#5E6875]"}`}>
                {currentSpread > 0 ? "+" : ""}{currentSpread.toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
