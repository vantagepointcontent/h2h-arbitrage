"use client";

import { useState, useEffect, useMemo } from "react";
import { getSpreadsForOutcome, SpreadPoint } from "@/lib/spreadHistory";

interface Props {
  marketId: string;
  outcomeArtist: string;
  onExpand?: () => void;
  isExpanded?: boolean;
}

/**
 * Mini inline sparkline showing recent ROI history for a market.
 * Data comes from the existing IndexedDB spreadHistory store.
 * Renders "—" when no historical data is available.
 */
export function ArbHistoryCell({ marketId, outcomeArtist, onExpand, isExpanded }: Props) {
  const [points, setPoints] = useState<SpreadPoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const from = now - 30 * 60 * 1000;
    getSpreadsForOutcome(marketId, outcomeArtist, from, now)
      .then((pts) => {
        if (!cancelled) setPoints(pts);
      })
      .catch(() => {
        if (!cancelled) setPoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, [marketId, outcomeArtist]);

  const sparkData = useMemo(() => {
    if (points.length < 5) return null;
    // Sample to max 30 points for the sparkline
    const maxPoints = 30;
    let sampled = points;
    if (points.length > maxPoints) {
      const step = Math.ceil(points.length / maxPoints);
      sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
    }
    const rois = sampled.map((p) => p.roiPct);
    const min = Math.min(...rois);
    const max = Math.max(...rois);
    const range = max - min || 1;
    return { rois, min, max, range };
  }, [points]);

  if (!sparkData) {
    return <span className="text-[#8A9BA8] text-xs">Collecting data…</span>;
  }

  // Build SVG sparkline path
  const width = 60;
  const height = 20;
  const { rois, min, range } = sparkData;
  const stepX = width / (rois.length - 1);

  const pathParts = rois.map((roi, i) => {
    const x = i * stepX;
    const y = height - ((roi - min) / range) * height;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = pathParts.join(" ");

  const lastRoi = rois[rois.length - 1];
  const strokeColor = lastRoi > 0 ? "#5DBE81" : lastRoi < 0 ? "#ef4444" : "#5E6875";
  const bestRoi = sparkData.max;
  const avgRoi = rois.reduce((s, r) => s + r, 0) / rois.length;

  const clickable = !!onExpand;

  return (
    <div
      className={`inline-flex items-center gap-1.5 ${clickable ? "cursor-pointer hover:bg-[#182533]/40 rounded px-1 -mx-1 transition-colors" : ""}`}
      title={`30m ROI: best ${bestRoi.toFixed(2)}%, avg ${avgRoi.toFixed(2)}%, ${rois.length} samples${clickable ? " — click to expand" : ""}`}
      onClick={clickable ? (e) => { e.stopPropagation(); onExpand!(); } : undefined}
    >
      <svg width={width} height={height} className={`inline-block ${isExpanded ? "opacity-60" : ""}`}>
        <path d={path} fill="none" stroke={strokeColor} strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point, i) => {
          const x = Math.min(i, rois.length - 1) * stepX;
          const y = height - ((point.roiPct - min) / range) * height;
          return <circle key={point.ts} cx={x} cy={y} r={3} fill="transparent"><title>{`${new Date(point.ts).toLocaleString()}: ${point.roiPct.toFixed(2)}%`}</title></circle>;
        })}
      </svg>
      <span className={`text-[10px] font-mono ${lastRoi > 0 ? "text-[#5DBE81]" : lastRoi < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]"}`}>
        {lastRoi > 0 ? "+" : ""}{lastRoi.toFixed(1)}%
      </span>
      {clickable && (
        <span className={`text-[#8A9BA8] text-[9px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>▾</span>
      )}
    </div>
  );
}
