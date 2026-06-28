"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Info, Clock, Settings2, ArrowUp, ArrowDown, Minus, RefreshCw, Zap } from "lucide-react";

// ── Threshold configuration (percentage points) ──
interface SpreadThresholds {
  green: number;   // Excellent spread
  yellow: number;  // Near-threshold
}

const DEFAULT_THRESHOLDS: SpreadThresholds = {
  green: 5,   // >= 5 cents = excellent arb
  yellow: 2,   // 2-5 cents = marginal
};

// ── Refresh interval presets (milliseconds) ──
const REFRESH_PRESETS = [
  { label: "5s", ms: 5000 },
  { label: "10s", ms: 10000 },
  { label: "15s", ms: 15000 },
  { label: "30s", ms: 30000 },
  { label: "60s", ms: 60000 },
];

interface PlatformPrice {
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  lastPrice: number;
  lastUpdated?: Date | null;
  // Depth of market (optional)
  bidVolume?: number;
  askVolume?: number;
}

interface OutcomeEntry {
  artist: string;
  platformA: PlatformPrice | null;
  platformB: {
    yesPrice: number;
    noPrice: number;
    bestBid: number;
    bestAsk: number;
    lastTradePrice: number;
    lastUpdated?: Date | null;
    bidVolume?: number;
    askVolume?: number;
  } | null;
}

interface Bookmaker1on1Props {
  outcomes: OutcomeEntry[];
  platformAName?: string;
  platformBName?: string;
  platformAIcon?: string;
  platformBIcon?: string;
  thresholds?: SpreadThresholds;
  lastUpdated?: Date | null;
  onThresholdChange?: (t: SpreadThresholds) => void;
  // Auto-refresh
  autoRefreshInterval?: number;  // ms, 0 = disabled
  onRefreshIntervalChange?: (ms: number) => void;
  // External data fetching callback for auto-refresh
  onRefresh?: () => Promise<void>;
}

/** Determine spread color class based on thresholds */
function spreadColorClass(spread: number, thresholds: SpreadThresholds): string {
  const abs = Math.abs(spread);
  if (abs >= thresholds.green) return "text-[#5DBE81]";
  if (abs >= thresholds.yellow) return "text-[#facc15]";
  return "text-[#ef4444]";
}

/** Background tint for spread badge */
function spreadBgClass(spread: number, thresholds: SpreadThresholds): string {
  const abs = Math.abs(spread);
  if (abs >= thresholds.green) return "bg-[#5DBE81]/15 ring-[#5DBE81]/30";
  if (abs >= thresholds.yellow) return "bg-[#facc15]/15 ring-[#facc15]/30";
  return "bg-[#ef4444]/15 ring-[#ef4444]/30";
}

/** Bar fill color */
function spreadBarClass(spread: number, thresholds: SpreadThresholds): string {
  const abs = Math.abs(spread);
  if (abs >= thresholds.green) return "bg-[#5DBE81]";
  if (abs >= thresholds.yellow) return "bg-[#facc15]";
  return "bg-red-400";
}

/** Format a price as cents display (e.g. 42.00) */
function fmtPrice(n: number): string {
  return n.toFixed(2);
}

/** Format spread with sign */
function fmtSpread(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

/** Relative time string */
function timeAgo(date: Date | null): string {
  if (!date) return "never";
  const diff = Date.now() - date.getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

/**
 * Compute price movement direction for flash animation.
 * Returns 'up' | 'down' | 'stable' | null (no previous).
 */
function priceDelta(current: number, previous: number | null): "up" | "down" | "stable" | null {
  if (previous === null) return null;
  const diff = current - previous;
  if (Math.abs(diff) < 0.001) return "stable";
  return diff > 0 ? "up" : "down";
}

/**
 * Movement arrow icon based on direction.
 */
function movementArrow(direction: "up" | "down" | "stable" | null): React.ReactNode {
  switch (direction) {
    case "up":
      return <ArrowUp className="w-2.5 h-2.5 text-[#5DBE81]" />;
    case "down":
      return <ArrowDown className="w-2.5 h-2.5 text-[#ef4444]" />;
    case "stable":
      return <Minus className="w-2.5 h-2.5 text-[#5E6875]" />;
    default:
      return null;
  }
}

/**
 * Flash class for animating price changes.
 * Triggers a CSS animation that fades out over 800ms.
 */
function flashClass(direction: "up" | "down" | "stable" | null): string {
  if (direction === "up") return "flash-green";
  if (direction === "down") return "flash-red";
  return "";
}

/**
 * Depth bar width percentage (normalized against max depth in dataset).
 */
function depthPercent(volume: number | undefined, maxVolume: number): number {
  if (volume == null || maxVolume === 0) return 0;
  return Math.min((volume / maxVolume) * 100, 100);
}

/**
 * Bookmaker-style odds board component.
 *
 * Layout mirrors professional trading terminals:
 *   [ Platform A prices ] [ Spread ] [ Platform B prices ]
 *
 * Each row = one outcome, side-by-side pricing with color-coded
 * spread indicator in the center column.
 *
 * Enhanced features:
 * - Green/red flash animations on price changes
 * - Movement indicators (▲▼→) showing price direction
 * - Auto-refresh with adjustable interval
 * - Depth of market visualization
 */
export function Bookmaker1on1({
  outcomes,
  platformAName = "Kalshi",
  platformBName = "Polymarket",
  platformAIcon = "/kalshi-icon.png",
  platformBIcon = "/polymarket-icon.png",
  thresholds = DEFAULT_THRESHOLDS,
  lastUpdated,
  onThresholdChange,
  autoRefreshInterval = 0,
  onRefreshIntervalChange,
  onRefresh,
}: Bookmaker1on1Props) {
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);
  const [showThresholds, setShowThresholds] = useState(false);
  const [editableThresholds, setEditableThresholds] = useState(thresholds);
  const [showRefreshControls, setShowRefreshControls] = useState(false);
  const [selectedRefreshIdx, setSelectedRefreshIdx] = useState(() => {
    if (autoRefreshInterval === 0) return -1;
    return REFRESH_PRESETS.findIndex(p => p.ms === autoRefreshInterval);
  });

  // Previous prices for detecting changes (flash animation)
  const prevPricesRef = useRef<Map<string, { yesBid: number; yesAsk: number; noBid: number; noAsk: number; yesPrice: number; bestBid: number; bestAsk: number }>>(new Map());

  // Track which cells are currently flashing
  const [flashingCells, setFlashingCells] = useState<Map<string, "up" | "down">>(new Map());

  // Auto-refresh timer
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync editable thresholds when prop changes
  useEffect(() => {
    setEditableThresholds(thresholds);
  }, [thresholds]);

  // Sync selected refresh index when prop changes
  useEffect(() => {
    if (autoRefreshInterval === 0) {
      setSelectedRefreshIdx(-1);
    } else {
      const idx = REFRESH_PRESETS.findIndex(p => p.ms === autoRefreshInterval);
      setSelectedRefreshIdx(idx);
    }
  }, [autoRefreshInterval]);

  // Detect price changes and trigger flash animations
  useEffect(() => {
    const newFlashes = new Map<string, "up" | "down">();
    const prev = prevPricesRef.current;

    outcomes.forEach((o) => {
      if (!o.platformA || !o.platformB) return;
      const key = o.artist;
      const curr = o.platformA;
      const pm = o.platformB;
      const prevEntry = prev.get(key);

      // Check each price field
      const fields: Array<{ field: string; currentVal: number }> = [
        { field: `${key}-aYesBid`, currentVal: curr.yesBid },
        { field: `${key}-aYesAsk`, currentVal: curr.yesAsk },
        { field: `${key}-aNoBid`, currentVal: curr.noBid },
        { field: `${key}-aNoAsk`, currentVal: curr.noAsk },
        { field: `${key}-bYesPrice`, currentVal: pm.yesPrice },
        { field: `${key}-bBestBid`, currentVal: pm.bestBid },
        { field: `${key}-bBestAsk`, currentVal: pm.bestAsk },
      ];

      fields.forEach(({ field, currentVal }) => {
        // @ts-ignore — pre-existing dynamic field access pattern
        const prevVal = prevEntry
          ? prevEntry[field.replace(/-.*/, "").replace("a", "").replace("b", "") === key
            ? (() => {
                if (field.includes("aYesBid")) return prevEntry.yesBid;
                if (field.includes("aYesAsk")) return prevEntry.yesAsk;
                if (field.includes("aNoBid")) return prevEntry.noBid;
                if (field.includes("aNoAsk")) return prevEntry.noAsk;
                if (field.includes("bYesPrice")) return prevEntry.yesPrice;
                if (field.includes("bBestBid")) return prevEntry.bestBid;
                if (field.includes("bBestAsk")) return prevEntry.bestAsk;
                return null;
              })()
            : null
          ]
          : null;

        // Simpler lookup
        let pv: number | null = null;
        if (prevEntry) {
          if (field.endsWith("aYesBid")) pv = prevEntry.yesBid;
          else if (field.endsWith("aYesAsk")) pv = prevEntry.yesAsk;
          else if (field.endsWith("aNoBid")) pv = prevEntry.noBid;
          else if (field.endsWith("aNoAsk")) pv = prevEntry.noAsk;
          else if (field.endsWith("bYesPrice")) pv = prevEntry.yesPrice;
          else if (field.endsWith("bBestBid")) pv = prevEntry.bestBid;
          else if (field.endsWith("bBestAsk")) pv = prevEntry.bestAsk;
        }

        const dir = priceDelta(currentVal, pv);
        if (dir === "up" || dir === "down") {
          newFlashes.set(field, dir);
        }
      });
    });

    // Update previous prices
    const newPrev = new Map<string, typeof prevPricesRef.current[number]>();
    outcomes.forEach((o) => {
      if (o.platformA && o.platformB) {
        newPrev.set(o.artist, {
          yesBid: o.platformA.yesBid,
          yesAsk: o.platformA.yesAsk,
          noBid: o.platformA.noBid,
          noAsk: o.platformA.noAsk,
          yesPrice: o.platformB.yesPrice,
          bestBid: o.platformB.bestBid,
          bestAsk: o.platformB.bestAsk,
        });
      }
    });
    prevPricesRef.current = newPrev;

    if (newFlashes.size > 0) {
      setFlashingCells(newFlashes);
      // Clear flash after animation completes
      setTimeout(() => setFlashingCells(new Map()), 800);
    }
  }, [outcomes]);

  // Auto-refresh management
  useEffect(() => {
    // Clear existing timer
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    if (autoRefreshInterval > 0 && onRefresh) {
      refreshTimerRef.current = setInterval(() => {
        onRefresh();
      }, autoRefreshInterval);
    }

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [autoRefreshInterval, onRefresh]);

  // Compute spreads for all outcomes
  const spreads = useMemo(() => {
    const map = new Map<string, number>();
    outcomes.forEach((o) => {
      if (o.platformA && o.platformB) {
        map.set(
          o.artist,
          +(o.platformB.yesPrice - o.platformA.yesAsk).toFixed(2)
        );
      }
    });
    return map;
  }, [outcomes]);

  // Compute max volumes for depth normalization
  const maxVolumes = useMemo(() => {
    let maxBid = 0, maxAsk = 0;
    (outcomes ?? []).forEach((o) => {
      if (o.platformA?.bidVolume) maxBid = Math.max(maxBid, o.platformA.bidVolume);
      if (o.platformA?.askVolume) maxBid = Math.max(maxBid, o.platformA.askVolume);
      if (o.platformB?.bidVolume) maxBid = Math.max(maxBid, o.platformB.bidVolume);
      if (o.platformB?.askVolume) maxBid = Math.max(maxBid, o.platformB.askVolume);
    });
    return { maxBid: maxBid || 1, maxAsk: maxAsk || 1 };
  }, [outcomes]);

  const validOutcomes = (outcomes ?? []).filter((o) => o.platformA && o.platformB);

  if (validOutcomes.length === 0) {
    return (
      <div className="rounded-xl border border-[#232E3C] bg-[#0E1621] p-8 text-center">
        <p className="text-[#8A9BA8] text-sm">No matched outcomes to display.</p>
      </div>
    );
  }

  const handleThresholdSave = useCallback(() => {
    onThresholdChange?.(editableThresholds);
    setShowThresholds(false);
  }, [editableThresholds, onThresholdChange]);

  const handleRefreshIntervalChange = useCallback((idx: number) => {
    setSelectedRefreshIdx(idx);
    if (idx >= 0) {
      onRefreshIntervalChange?.(REFRESH_PRESETS[idx].ms);
    } else {
      onRefreshIntervalChange?.(0);
    }
  }, [onRefreshIntervalChange]);

  return (
    <div className="rounded-xl border border-[#232E3C] bg-[#0E1621] overflow-hidden">
      {/* ── Header Row ── */}
      <div className="grid grid-cols-[1fr_auto_1fr] bg-[#17212B] border-b border-[#232E3C]">
        {/* Platform A header */}
        <div className="col-span-1 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <img
              src={platformAIcon}
              alt={platformAName}
              className="w-5 h-5 rounded-sm"
            />
            <span className="text-[10px] uppercase tracking-wider text-[#8A9BA8] font-medium">
              {platformAName}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-1 mt-1">
            <span className="text-[9px] text-[#5E6875] uppercase text-center">
              Yes Bid
            </span>
            <span className="text-[9px] text-[#5E6875] uppercase text-center">
              Yes Ask
            </span>
          </div>
        </div>

        {/* Spread header */}
        <div className="col-auto px-1 py-2.5 text-center flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[#8A9BA8] font-medium">
            Spread
          </span>
          <button
            onClick={() => setShowThresholds((v) => !v)}
            className="inline-flex items-center justify-center w-4 h-4 rounded hover:bg-[#232E3C] text-[#5E6875] hover:text-[#8A9BA8] transition-colors"
            title="Configure thresholds"
          >
            <Settings2 className="w-3 h-3" />
          </button>
        </div>

        {/* Platform B header */}
        <div className="col-span-1 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <img
              src={platformBIcon}
              alt={platformBName}
              className="w-5 h-5 rounded-sm"
            />
            <span className="text-[10px] uppercase tracking-wider text-[#8A9BA8] font-medium">
              {platformBName}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-1 mt-1">
            <span className="text-[9px] text-[#5E6875] uppercase text-center">
              Best Bid
            </span>
            <span className="text-[9px] text-[#5E6875] uppercase text-center">
              Best Ask
            </span>
          </div>
        </div>
      </div>

      {/* ── Threshold Configuration Panel ── */}
      {showThresholds && (
        <div className="border-b border-[#232E3C] bg-[#17212B]/80 px-3 py-2.5 flex items-center gap-4 flex-wrap">
          <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wider">
            Thresholds:
          </span>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-[#5DBE81]" />
            <span className="text-[10px] text-[#8A9BA8]">&ge;</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={editableThresholds.green}
              onChange={(e) =>
                setEditableThresholds((t) => ({
                  ...t,
                  green: parseFloat(e.target.value) || 0,
                }))
              }
              className="w-12 px-1.5 py-0.5 rounded bg-[#232E3C] border border-[#3f3f3f] text-[10px] text-[#8A9BA8] text-center focus:outline-none focus:border-[#5DBE81]"
            />
            <span className="text-[10px] text-[#8A9BA8]">&#8270; great</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-[#facc15]" />
            <span className="text-[10px] text-[#8A9BA8]">{editableThresholds.yellow}&#8211;</span>
            <span className="text-[10px] text-[#8A9BA8]">
              {editableThresholds.green - 1}&cent; ok
            </span>
          </div>
          <button
            onClick={handleThresholdSave}
            className="px-2 py-0.5 rounded bg-[#5DBE81]/20 text-[#5DBE81] text-[10px] font-medium hover:bg-[#5DBE81]/30 transition-colors"
          >
            Apply
          </button>
        </div>
      )}

      {/* ── Auto-Refresh Controls ── */}
      <div className="border-b border-[#232E3C] bg-[#17212B]/60 px-3 py-1.5 flex items-center gap-2">
        <button
          onClick={() => setShowRefreshControls((v) => !v)}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-[#232E3C] transition-colors"
        >
          <Zap className="w-3 h-3" />
          {autoRefreshInterval > 0
            ? `Auto: ${REFRESH_PRESETS.find(p => p.ms === autoRefreshInterval)?.label || "off"}`
            : "Auto-refresh: Off"}
        </button>

        {showRefreshControls && (
          <>
            <span className="text-[10px] text-[#5E6875]">|</span>
            <span className="text-[10px] text-[#8A9BA8]">Interval:</span>
            {REFRESH_PRESETS.map((preset, idx) => (
              <button
                key={preset.ms}
                onClick={() => handleRefreshIntervalChange(idx)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${
                  selectedRefreshIdx === idx
                    ? "bg-[#5DBE81]/20 text-[#5DBE81] ring-1 ring-[#5DBE81]/30"
                    : "bg-[#232E3C] text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-zinc-700"
                }`}
              >
                {preset.label}
              </button>
            ))}
            <button
              onClick={() => handleRefreshIntervalChange(-1)}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                selectedRefreshIdx === -1
                  ? "bg-zinc-700 text-[#FFFFFF]"
                  : "text-[#8A9BA8] hover:text-[#8A9BA8]"
              }`}
            >
              Off
            </button>
            {onRefresh && (
              <>
                <span className="text-[10px] text-[#5E6875]">|</span>
                <button
                  onClick={onRefresh}
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#232E3C] text-[10px] text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-zinc-700 transition-colors"
                >
                  <RefreshCw className="w-3 h-3" /> Now
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* ── Outcome Rows ── */}
      <div className="divide-y divide-zinc-800">
        {validOutcomes.map((outcome, oidx) => {
          const spread = spreads.get(outcome.artist) ?? 0;
          const isHovered = hoveredRow === outcome.artist;
          const a = outcome.platformA!;
          const b = outcome.platformB!;

          // Flash states for each cell
          const flashAYesBid = flashingCells.get(`${outcome.artist}-aYesBid`);
          const flashAYesAsk = flashingCells.get(`${outcome.artist}-aYesAsk`);
          const flashANoBid = flashingCells.get(`${outcome.artist}-aNoBid`);
          const flashANoAsk = flashingCells.get(`${outcome.artist}-aNoAsk`);
          const flashBYesPrice = flashingCells.get(`${outcome.artist}-bYesPrice`);
          const flashBBestBid = flashingCells.get(`${outcome.artist}-bBestBid`);
          const flashBBestAsk = flashingCells.get(`${outcome.artist}-bBestAsk`);

          return (
            <div
              key={`${oidx}-${outcome.artist}`}
              className={`grid grid-cols-[1fr_auto_1fr] transition-colors duration-150 ${
                isHovered ? "bg-[#232E3C]/60" : ""
              }`}
              onMouseEnter={() => setHoveredRow(outcome.artist)}
              onMouseLeave={() => {
                setHoveredRow(null);
                setHoveredCell(null);
              }}
            >
              {/* ── Platform A Column ── */}
              <div className="col-span-1 px-3 py-2">
                {/* Outcome label */}
                <div className="mb-1.5">
                  <span className="text-[11px] font-medium text-[#FFFFFF] truncate block">
                    {outcome.artist}
                  </span>
                </div>

                {/* YES prices */}
                <div className="grid grid-cols-2 gap-1">
                  {/* YES BID */}
                  <PriceCellWithFlash
                    value={a.yesBid}
                    cellKey={`${outcome.artist}-aYesBid`}
                    isHovered={hoveredCell === `${outcome.artist}-aYesBid`}
                    onHover={() => setHoveredCell(`${outcome.artist}-aYesBid`)}
                    onLeave={() => setHoveredCell(null)}
                    lastUpdated={a.lastUpdated ?? lastUpdated}
                    flashDir={flashAYesBid}
                    primary
                    depthVolume={a.bidVolume}
                    maxVolume={maxVolumes.maxBid}
                    depthSide="bid"
                  />
                  {/* YES ASK */}
                  <PriceCellWithFlash
                    value={a.yesAsk}
                    cellKey={`${outcome.artist}-aYesAsk`}
                    isHovered={hoveredCell === `${outcome.artist}-aYesAsk`}
                    onHover={() => setHoveredCell(`${outcome.artist}-aYesAsk`)}
                    onLeave={() => setHoveredCell(null)}
                    lastUpdated={a.lastUpdated ?? lastUpdated}
                    flashDir={flashAYesAsk}
                    primary
                    depthVolume={a.askVolume}
                    maxVolume={maxVolumes.maxAsk}
                    depthSide="ask"
                  />
                </div>

                {/* NO prices (compact) */}
                <div className="grid grid-cols-2 gap-1 mt-0.5">
                  <PriceCellWithFlash
                    value={a.noBid}
                    cellKey={`${outcome.artist}-aNoBid`}
                    isHovered={hoveredCell === `${outcome.artist}-aNoBid`}
                    onHover={() => setHoveredCell(`${outcome.artist}-aNoBid`)}
                    onLeave={() => setHoveredCell(null)}
                    lastUpdated={a.lastUpdated ?? lastUpdated}
                    flashDir={flashANoBid}
                    depthVolume={a.bidVolume}
                    maxVolume={maxVolumes.maxBid}
                    depthSide="bid"
                  />
                  <PriceCellWithFlash
                    value={a.noAsk}
                    cellKey={`${outcome.artist}-aNoAsk`}
                    isHovered={hoveredCell === `${outcome.artist}-aNoAsk`}
                    onHover={() => setHoveredCell(`${outcome.artist}-aNoAsk`)}
                    onLeave={() => setHoveredCell(null)}
                    lastUpdated={a.lastUpdated ?? lastUpdated}
                    flashDir={flashANoAsk}
                    depthVolume={a.askVolume}
                    maxVolume={maxVolumes.maxAsk}
                    depthSide="ask"
                  />
                </div>
              </div>

              {/* ── Center: Spread Column ── */}
              <div className="col-auto px-1 py-2 flex flex-col items-center justify-center gap-1">
                {/* Spread badge */}
                <div
                  className={`px-2.5 py-1 rounded-full text-xs font-bold font-mono ring-1 transition-colors duration-300 ${spreadColorClass(spread, thresholds)} ${spreadBgClass(spread, thresholds)}`}
                >
                  {fmtSpread(spread)}
                </div>

                {/* Visual spread bar */}
                <div className="w-full max-w-[48px] h-1 rounded-full bg-[#232E3C] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${spreadBarClass(spread, thresholds)}`}
                    style={{
                      width: `${Math.min(Math.abs(spread) * 8, 100)}%`,
                    }}
                  />
                </div>

                {/* Spread detail tooltip */}
                <div className="relative group">
                  <Info className="w-3 h-3 text-[#5E6875] cursor-help" />
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1.5 rounded bg-[#232E3C] text-[10px] text-[#8A9BA8] whitespace-nowrap z-10 hidden group-hover:block border border-[#3f3f3f] shadow-lg">
                    <div>{platformAName} ask: {fmtPrice(a.yesAsk)}</div>
                    <div>{platformBName} price: {fmtPrice(b.yesPrice)}</div>
                    <div className="border-t border-[#3f3f3f] my-1" />
                    <div className="font-bold">
                      Diff: {fmtSpread(spread)}&#8270;
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Platform B Column ── */}
              <div className="col-span-1 px-3 py-2">
                {/* YES prices */}
                <div className="grid grid-cols-2 gap-1">
                  <PriceCellWithFlash
                    value={b.bestBid}
                    cellKey={`${outcome.artist}-bBestBid`}
                    isHovered={hoveredCell === `${outcome.artist}-bBestBid`}
                    onHover={() => setHoveredCell(`${outcome.artist}-bBestBid`)}
                    onLeave={() => setHoveredCell(null)}
                    lastUpdated={b.lastUpdated ?? lastUpdated}
                    flashDir={flashBBestBid}
                    primary
                    depthVolume={b.bidVolume}
                    maxVolume={maxVolumes.maxBid}
                    depthSide="bid"
                  />
                  <PriceCellWithFlash
                    value={b.bestAsk}
                    cellKey={`${outcome.artist}-bBestAsk`}
                    isHovered={hoveredCell === `${outcome.artist}-bBestAsk`}
                    onHover={() => setHoveredCell(`${outcome.artist}-bBestAsk`)}
                    onLeave={() => setHoveredCell(null)}
                    lastUpdated={b.lastUpdated ?? lastUpdated}
                    flashDir={flashBBestAsk}
                    primary
                    depthVolume={b.askVolume}
                    maxVolume={maxVolumes.maxAsk}
                    depthSide="ask"
                  />
                </div>

                {/* NO prices (compact) */}
                <div className="grid grid-cols-2 gap-1 mt-0.5">
                  <PriceCellWithFlash
                    value={b.noPrice}
                    cellKey={`${outcome.artist}-bNoBid`}
                    isHovered={hoveredCell === `${outcome.artist}-bNoBid`}
                    onHover={() => setHoveredCell(`${outcome.artist}-bNoBid`)}
                    onLeave={() => setHoveredCell(null)}
                    lastUpdated={b.lastUpdated ?? lastUpdated}
                  />
                  <PriceCellWithFlash
                    value={b.noPrice}
                    cellKey={`${outcome.artist}-bNoAsk`}
                    isHovered={hoveredCell === `${outcome.artist}-bNoAsk`}
                    onHover={() => setHoveredCell(`${outcome.artist}-bNoAsk`)}
                    onLeave={() => setHoveredCell(null)}
                    lastUpdated={b.lastUpdated ?? lastUpdated}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Footer Legend ── */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-[#232E3C] bg-[#17212B]">
        <div className="flex items-center gap-4 text-[10px] text-[#5E6875]">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-[#5DBE81]" />
            &#8805;{thresholds.green}&cent;
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-[#facc15]" />
            {thresholds.yellow}&#8211;{thresholds.green - 1}&cent;
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400" />
            &#60;{thresholds.yellow}&cent;
          </span>
        </div>
        <div className="text-[10px] text-[#5E6875]">
          {validOutcomes.length} outcome{validOutcomes.length !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );
}

/* ── Price Cell with Flash Animation, Movement Indicator, and Depth Bar ── */
function PriceCellWithFlash({
  value,
  cellKey,
  isHovered,
  onHover,
  onLeave,
  lastUpdated,
  flashDir,
  primary = false,
  depthVolume,
  maxVolume,
  depthSide,
}: {
  value: number;
  cellKey: string;
  isHovered: boolean;
  onHover: () => void;
  onLeave: () => void;
  lastUpdated: Date | null;
  flashDir: "up" | "down" | null;
  primary?: boolean;
  depthVolume?: number;
  maxVolume?: number;
  depthSide?: "bid" | "ask";
}) {
  const flashCls = flashDir ? flashClass(flashDir) : "";
  const arrow = movementArrow(flashDir);

  return (
    <div
      className="relative group"
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
    >
      <div
        className={`text-center py-1.5 px-1 rounded font-mono transition-colors flex flex-col items-center gap-0.5 ${flashCls} ${
          primary
            ? "bg-[#232E3C] text-sm text-[#FFFFFF]"
            : "bg-[#232E3C]/50 text-[11px] text-[#8A9BA8]"
        }`}
      >
        {/* Price value with movement arrow */}
        <div className="flex items-center gap-0.5 justify-center">
          {arrow}
          <span>{fmtPrice(value)}</span>
        </div>

        {/* Depth bar */}
        {depthVolume != null && maxVolume != null && (
          <div className="w-full mt-0.5">
            <div
              className={`depth-bar ${depthSide === "bid" ? "depth-bar-bid" : "depth-bar-ask"}`}
              style={{ width: `${depthPercent(depthVolume, maxVolume)}%` }}
            />
          </div>
        )}
      </div>
      {isHovered && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-[#232E3C] text-[10px] text-[#8A9BA8] whitespace-nowrap z-10 pointer-events-none border border-[#3f3f3f] shadow-lg">
          <Clock className="w-3 h-3 inline mr-1" />
          Updated {timeAgo(lastUpdated)}
        </div>
      )}
    </div>
  );
}
