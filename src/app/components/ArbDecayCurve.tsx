"use client";

import { useState, useEffect, useMemo } from "react";
import { calculateArbMomentum } from "@/lib/arb-momentum";

interface Props {
  marketId: string;
  outcome: string;
  /** Compact card variant: directional signal and tooltip without the chart. */
  compact?: boolean;
}

interface DecayPoint {
  seenAt: string;
  roiPct: number;
  expectedProfit: number;
  totalStake: number;
}

interface EpisodeData {
  episodeId: number;
  outcome: string;
  strategy: string;
  firstSeenAt: string;
  lastSeenAt: string;
  scanCount: number;
  firstRoiPct: number;
  peakRoiPct: number;
  lastRoiPct: number;
  durationSec: number;
  points: DecayPoint[];
  trend: "rising" | "plateau" | "declining";
}

/**
 * UI-09: Arb Decay Curve — per-episode ROI trajectory visualization.
 *
 * Shows the ROI trajectory of the SPECIFIC arb episode currently open:
 * from when it first appeared, through its peak, to now.
 *
 * Data source: arb_episode_points table (SQLite, server-side, per-scan).
 * Distinct from ArbHistoryCell which shows 24h market-level ROI history
 * from client-side IndexedDB spreadHistory.
 *
 * Color coding: green = rising, yellow = plateau, red = declining.
 * Direction arrow: ↗ widening / ↘ vanishing / ─ stable.
 * Tooltip: episode duration, peak ROI, current ROI, scan count.
 */
export function ArbDecayCurve({ marketId, outcome, compact = false }: Props) {
  const [episode, setEpisode] = useState<EpisodeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  // Keep the indicator aligned with the app's gentle 60-second scan cadence.
  useEffect(() => {
    const interval = window.setInterval(() => setRefreshTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const url = `/api/arb-episodes/active?marketId=${encodeURIComponent(marketId)}&outcome=${encodeURIComponent(outcome)}`;

    fetch(url, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const eps = data?.episodes?.[0] ?? null;
        setEpisode(eps);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setEpisode(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [marketId, outcome, refreshTick]);

  const chartData = useMemo(() => {
    if (!episode || episode.points.length < 1) return null;

    const pts = episode.points;
    const rois = pts.map((p) => p.roiPct);
    const min = Math.min(...rois, 0);
    const max = Math.max(...rois, 0.1);
    const range = max - min || 1;

    // Time axis: minutes since episode open
    const firstMs = new Date(pts[0].seenAt).getTime();
    const timeMins = pts.map((p) => (new Date(p.seenAt).getTime() - firstMs) / 60000);
    const maxTime = Math.max(...timeMins, 1);

    return { rois, min, max, range, timeMins, maxTime, pts };
  }, [episode]);

  if (loading) {
    return <span className="text-[#8A9BA8] text-xs">···</span>;
  }

  if (!episode || !chartData) {
    return <span className="text-[#8A9BA8] text-xs">—</span>;
  }

  const { rois, min, range, timeMins, maxTime, pts } = chartData;
  const width = 70;
  const height = 22;
  const padTop = 2;
  const padBot = 2;
  const chartH = height - padTop - padBot;

  // Build SVG path: x = time since open, y = ROI
  const stepX = maxTime > 0 ? width / maxTime : width;
  const pathParts = pts.map((p, i) => {
    const x = timeMins[i] * stepX;
    const y = padTop + chartH - ((p.roiPct - min) / range) * chartH;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = pathParts.join(" ");

  // Color based on trend
  const trend = episode.trend;
  const strokeColor =
    trend === "rising" ? "#5DBE81" :
    trend === "declining" ? "#ef4444" : "#facc15";

  const momentum = calculateArbMomentum(pts);

  // Direction arrow
  const arrow =
    momentum.direction === "widening" ? "↑" :
    momentum.direction === "narrowing" ? "↓" : "—";

  const arrowColor =
    momentum.direction === "widening" ? "text-[#5DBE81]" :
    momentum.direction === "narrowing" ? "text-[#ef4444]" : "text-[#8A9BA8]";

  // "Act speed" — minutes the arb has been continuously profitable
  const actSpeedMin = Math.round(episode.durationSec / 60);
  const actSpeedLabel =
    actSpeedMin >= 60 ? `${Math.floor(actSpeedMin / 60)}h${actSpeedMin % 60}m` :
    actSpeedMin > 0 ? `${actSpeedMin}m` :
    "<1m";

  // Tooltip text
  const tooltip =
    `Episode: ${episode.strategy}\n` +
    `Duration: ${actSpeedLabel} (since first seen)\n` +
    `Peak ROI: ${episode.peakRoiPct.toFixed(2)}%\n` +
    `Current ROI: ${episode.lastRoiPct.toFixed(2)}%\n` +
    `First ROI: ${episode.firstRoiPct.toFixed(2)}%\n` +
    `Scans: ${episode.scanCount}\n` +
    `Trend: ${trend}\n` +
    `Momentum: ${momentum.deltaPct >= 0 ? "+" : ""}${momentum.deltaPct.toFixed(2)}% in ${momentum.windowSeconds}s (${momentum.sampleCount} scans)`;

  if (compact) {
    return (
      <span className={`text-sm font-bold leading-none ${arrowColor}`} title={tooltip} aria-label={`Momentum ${momentum.direction}`}>
        {arrow}
      </span>
    );
  }

  // Peak marker position
  const peakIdx = rois.indexOf(Math.max(...rois));
  const peakX = timeMins[peakIdx] * stepX;
  const peakY = padTop + chartH - ((rois[peakIdx] - min) / range) * chartH;

  return (
    <div className="inline-flex items-center gap-1" title={tooltip}>
      <svg width={width} height={height} className="inline-block">
        {/* Baseline at ROI=0 */}
        {min < 0 && (
          <line
            x1={0} x2={width}
            y1={padTop + chartH - ((0 - min) / range) * chartH}
            y2={padTop + chartH - ((0 - min) / range) * chartH}
            stroke="#182533" strokeWidth={0.5} strokeDasharray="2,2"
          />
        )}
        {/* Decay curve */}
        <path d={path} fill="none" stroke={strokeColor} strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" />
        {/* Peak marker */}
        {pts.length > 1 && (
          <circle cx={peakX} cy={peakY} r={1.5} fill={strokeColor} opacity={0.7} />
        )}
        {/* Last point marker */}
        {pts.length > 0 && (() => {
          const lastX = timeMins[timeMins.length - 1] * stepX;
          const lastY = padTop + chartH - ((rois[rois.length - 1] - min) / range) * chartH;
          return <circle cx={lastX} cy={lastY} r={1.8} fill={strokeColor} />;
        })()}
      </svg>
      <span className={`text-[10px] font-mono ${arrowColor}`} title={`Trend: ${trend}`}>
        {arrow}
      </span>
      <span className="text-[10px] font-mono text-[#8A9BA8]" title="Act speed: time profitable">
        {actSpeedLabel}
      </span>
    </div>
  );
}