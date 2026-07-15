"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { getSpreadsForOutcome, SpreadPoint, TIME_RANGES, type TimeRange } from "@/lib/spreadHistory";

interface Props {
  marketId: string;
  outcomeArtist: string;
  onClose: () => void;
}

const RANGES: { key: TimeRange; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

/**
 * Expanded ROI history chart with proper x/y axes.
 * Renders inline within the expandable row section.
 * Shows a longer timeline than the mini sparkline and supports range switching.
 */
export function ExpandedChart({ marketId, outcomeArtist, onClose }: Props) {
  const [points, setPoints] = useState<SpreadPoint[]>([]);
  const [range, setRange] = useState<TimeRange>("24h");
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const from = now - TIME_RANGES[range];
    setLoading(true);
    getSpreadsForOutcome(marketId, outcomeArtist, from, now)
      .then((pts) => {
        if (!cancelled) {
          setPoints(pts);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPoints([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [marketId, outcomeArtist, range]);

  // Responsive: observe container width
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chartData = useMemo(() => {
    if (points.length < 2) return null;

    // Use all points for the expanded chart (cap at 200 for performance)
    let sampled = points;
    const maxPoints = 200;
    if (points.length > maxPoints) {
      const step = Math.ceil(points.length / maxPoints);
      sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
    }

    const rois = sampled.map((p) => p.roiPct);
    const timestamps = sampled.map((p) => p.ts);
    const min = Math.min(...rois);
    const max = Math.max(...rois);
    const range = max - min || 1;
    // Pad y range a bit
    const yMin = min - range * 0.1;
    const yMax = max + range * 0.1;
    const yRange = yMax - yMin || 1;

    return { rois, timestamps, min, max, yMin, yMax, yRange, count: points.length };
  }, [points]);

  // Chart dimensions
  const chartHeight = 240;
  const marginLeft = 56;
  const marginRight = 16;
  const marginTop = 16;
  const marginBottom = 36;
  const width = Math.max(containerWidth, 320);
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = chartHeight - marginTop - marginBottom;

  // Y-axis ticks (5 ticks)
  const yTicks = useMemo(() => {
    if (!chartData) return [];
    const ticks: { value: number; y: number }[] = [];
    for (let i = 0; i <= 4; i++) {
      const val = chartData.yMin + (chartData.yRange * i) / 4;
      const y = marginTop + plotHeight - (i / 4) * plotHeight;
      ticks.push({ value: val, y });
    }
    return ticks;
  }, [chartData, plotHeight, marginTop]);

  // X-axis ticks (5-6 ticks)
  const xTicks = useMemo(() => {
    if (!chartData) return [];
    const { timestamps } = chartData;
    const minTs = timestamps[0];
    const maxTs = timestamps[timestamps.length - 1];
    const tickCount = Math.min(6, timestamps.length);
    const ticks: { label: string; x: number }[] = [];
    for (let i = 0; i < tickCount; i++) {
      const ts = minTs + ((maxTs - minTs) * i) / (tickCount - 1);
      const x = marginLeft + (i / (tickCount - 1)) * plotWidth;
      const d = new Date(ts);
      const label = range === "24h"
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString([], { month: "short", day: "numeric" });
      ticks.push({ label, x });
    }
    return ticks;
  }, [chartData, plotWidth, marginLeft, range]);

  // Build chart path
  const chartPath = useMemo(() => {
    if (!chartData) return "";
    const { rois, timestamps, yMin, yRange } = chartData;
    const minTs = timestamps[0];
    const maxTs = timestamps[timestamps.length - 1];
    const tsRange = maxTs - minTs || 1;

    return rois
      .map((roi, i) => {
        const x = marginLeft + ((timestamps[i] - minTs) / tsRange) * plotWidth;
        const y = marginTop + plotHeight - ((roi - yMin) / yRange) * plotHeight;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [chartData, plotWidth, plotHeight, marginLeft, marginTop]);

  // Zero line position (if in range)
  const zeroY = chartData && chartData.yMin <= 0 && chartData.yMax >= 0
    ? marginTop + plotHeight - ((0 - chartData.yMin) / chartData.yRange) * plotHeight
    : null;

  if (loading) {
    return (
      <div ref={containerRef} className="w-full flex items-center justify-center py-8">
        <span className="text-[#8A9BA8] text-sm">Loading chart data...</span>
      </div>
    );
  }

  if (!chartData) {
    return (
      <div ref={containerRef} className="w-full flex items-center justify-center py-8">
        <span className="text-[#8A9BA8] text-sm">No historical data for this market in the selected range.</span>
      </div>
    );
  }

  const lastRoi = chartData.rois[chartData.rois.length - 1];
  const strokeColor = lastRoi > 0 ? "#5DBE81" : lastRoi < 0 ? "#ef4444" : "#5E6875";
  const bestRoi = chartData.max;
  const avgRoi = chartData.rois.reduce((s, r) => s + r, 0) / chartData.rois.length;
  const worstRoi = chartData.min;

  return (
    <div ref={containerRef} className="w-full mt-4 pt-4 border-t border-[#182533]">
      {/* Header row: title + range buttons + close */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wider text-[#8A9BA8] font-medium">
            ROI History — {outcomeArtist}
          </span>
          <div className="flex items-center gap-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={(e) => { e.stopPropagation(); setRange(r.key); }}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  range === r.key
                    ? "bg-[#facc15]/20 text-[#facc15]"
                    : "text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-[#182533]"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="text-[#8A9BA8] hover:text-[#FFFFFF] text-xs transition-colors"
          title="Collapse chart"
        >
          ✕
        </button>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 mb-2 text-[11px] font-mono">
        <span className="text-[#8A9BA8]">Best: <span className="text-[#5DBE81] font-bold">+{bestRoi.toFixed(2)}%</span></span>
        <span className="text-[#8A9BA8]">Avg: <span className="text-[#FFFFFF] font-bold">{avgRoi.toFixed(2)}%</span></span>
        <span className="text-[#8A9BA8]">Worst: <span className="text-[#ef4444] font-bold">{worstRoi.toFixed(2)}%</span></span>
        <span className="text-[#8A9BA8]">Current: <span className={lastRoi > 0 ? "text-[#5DBE81] font-bold" : lastRoi < 0 ? "text-[#ef4444] font-bold" : "text-[#FFFFFF] font-bold"}>{lastRoi > 0 ? "+" : ""}{lastRoi.toFixed(2)}%</span></span>
        <span className="text-[#8A9BA8]">{chartData.count} samples</span>
      </div>

      {/* SVG chart */}
      <svg
        width={width}
        height={chartHeight}
        className="block max-w-full overflow-visible"
        style={{ touchAction: "manipulation" }}
      >
        {/* Y-axis grid lines + labels */}
        {yTicks.map((tick, i) => (
          <g key={`y-${i}`}>
            <line
              x1={marginLeft}
              y1={tick.y}
              x2={marginLeft + plotWidth}
              y2={tick.y}
              stroke={tick.value === 0 ? "#232E3C" : "#182533"}
              strokeWidth={tick.value === 0 ? 1 : 0.5}
              strokeDasharray={tick.value === 0 ? "" : "2,3"}
            />
            <text
              x={marginLeft - 8}
              y={tick.y + 3}
              textAnchor="end"
              fill="#8A9BA8"
              fontSize={10}
              fontFamily="monospace"
            >
              {tick.value.toFixed(1)}%
            </text>
          </g>
        ))}

        {/* Zero line emphasis */}
        {zeroY && (
          <line
            x1={marginLeft}
            y1={zeroY}
            x2={marginLeft + plotWidth}
            y2={zeroY}
            stroke="#5E6875"
            strokeWidth={1}
            strokeDasharray="4,4"
          />
        )}

        {/* X-axis line */}
        <line
          x1={marginLeft}
          y1={marginTop + plotHeight}
          x2={marginLeft + plotWidth}
          y2={marginTop + plotHeight}
          stroke="#232E3C"
          strokeWidth={1}
        />

        {/* X-axis ticks + labels */}
        {xTicks.map((tick, i) => (
          <g key={`x-${i}`}>
            <line
              x1={tick.x}
              y1={marginTop + plotHeight}
              x2={tick.x}
              y2={marginTop + plotHeight + 4}
              stroke="#5E6875"
              strokeWidth={1}
            />
            <text
              x={tick.x}
              y={marginTop + plotHeight + 18}
              textAnchor="middle"
              fill="#8A9BA8"
              fontSize={10}
              fontFamily="monospace"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Axis labels */}
        <text
          x={marginLeft - 40}
          y={marginTop + plotHeight / 2}
          textAnchor="middle"
          fill="#8A9BA8"
          fontSize={10}
          transform={`rotate(-90, ${marginLeft - 40}, ${marginTop + plotHeight / 2})`}
        >
          ROI %
        </text>
        <text
          x={marginLeft + plotWidth / 2}
          y={chartHeight - 4}
          textAnchor="middle"
          fill="#8A9BA8"
          fontSize={10}
        >
          Time
        </text>

        {/* Area fill under the line */}
        <path
          d={`${chartPath} L${marginLeft + plotWidth},${marginTop + plotHeight} L${marginLeft},${marginTop + plotHeight} Z`}
          fill={strokeColor}
          opacity={0.08}
        />

        {/* Main line */}
        <path
          d={chartPath}
          fill="none"
          stroke={strokeColor}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* End point dot */}
        {chartData && (() => {
          const { rois, timestamps, yMin, yRange } = chartData;
          const minTs = timestamps[0];
          const maxTs = timestamps[timestamps.length - 1];
          const tsRange = maxTs - minTs || 1;
          const lastIdx = rois.length - 1;
          const x = marginLeft + ((timestamps[lastIdx] - minTs) / tsRange) * plotWidth;
          const y = marginTop + plotHeight - ((rois[lastIdx] - yMin) / yRange) * plotHeight;
          return <circle cx={x} cy={y} r={3.5} fill={strokeColor} />;
        })()}
      </svg>
    </div>
  );
}