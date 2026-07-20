"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { Info, Clock, ArrowUp, ArrowDown, Minus, RefreshCw } from "lucide-react";
import { useLivePrices } from "@/lib/use-live-prices";
import { formatPrice } from "@/app/lib/page-shared";

// ── Threshold configuration (percentage points) ──
interface SpreadThresholds {
  green: number;   // Excellent spread
  yellow: number;  // Near-threshold
}

const THRESHOLDS: SpreadThresholds = {
  green: 5,   // >= 5 cents = excellent arb
  yellow: 2,   // 2-5 cents = marginal
};

interface PlatformPrice {
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  lastPrice: number | null;
  lastUpdated?: Date | null;
  // Depth of market (optional)
  bidVolume?: number;
  askVolume?: number;
}

interface OutcomeEntry {
  artist: string;
  platformA: PlatformPrice | null;
  platformB: {
    yesPrice: number | null;
    noPrice: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    lastTradePrice: number | null;
    lastUpdated?: Date | null;
    bidVolume?: number;
    askVolume?: number;
  } | null;
}

interface Bookmaker1on1Props {
  outcomes: OutcomeEntry[];
  lastUpdated?: Date | null;
  // Live WS props
  kalshiUrl?: string;
  pmUrl?: string;
  capital?: number;
  liveMode?: boolean;
}

/** Determine spread color class based on thresholds */
function spreadColorClass(spread: number | null, thresholds: SpreadThresholds): string {
  if (spread == null) return "text-[#8A9BA8]";
  const abs = Math.abs(spread);
  if (abs >= thresholds.green) return "text-[#5DBE81]";
  if (abs >= thresholds.yellow) return "text-[#facc15]";
  return "text-[#ef4444]";
}

/** Background tint for spread badge */
function spreadBgClass(spread: number | null, thresholds: SpreadThresholds): string {
  if (spread == null) return "bg-[#8A9BA8]/15 ring-[#8A9BA8]/30";
  const abs = Math.abs(spread);
  if (abs >= thresholds.green) return "bg-[#5DBE81]/15 ring-[#5DBE81]/30";
  if (abs >= thresholds.yellow) return "bg-[#facc15]/15 ring-[#facc15]/30";
  return "bg-[#ef4444]/15 ring-[#ef4444]/30";
}

/** Bar fill color */
function spreadBarClass(spread: number | null, thresholds: SpreadThresholds): string {
  if (spread == null) return "bg-[#8A9BA8]";
  const abs = Math.abs(spread);
  if (abs >= thresholds.green) return "bg-[#5DBE81]";
  if (abs >= thresholds.yellow) return "bg-[#facc15]";
  return "bg-red-400";
}

/** Format a price as cents display (e.g. 42.00) — null-safe, shows "—" for missing data */
function fmtPrice(n: number | null | undefined): string {
  return formatPrice(n);
}

/** Format spread with sign — null-safe */
function fmtSpread(n: number | null | undefined): string {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

/** Relative time string */
function timeAgo(date: Date | null | undefined): string {
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
function priceDelta(current: number | null, previous: number | null): "up" | "down" | "stable" | null {
  if (current == null || previous === null) return null;
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
      return <Minus className="w-2.5 h-2.5 text-[#8A9BA8]" />;
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
function depthPercent(volume: number | null | undefined, maxVolume: number): number {
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
  lastUpdated,
  kalshiUrl,
  pmUrl,
  capital = 10,
  liveMode = false,
}: Bookmaker1on1Props) {
  const platformAName = "Kalshi";
  const platformBName = "Polymarket";
  const platformAIcon = "/kalshi-icon.png";
  const platformBIcon = "/polymarket-icon.png";
  const thresholds = THRESHOLDS;
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);

  // Previous prices for detecting changes (flash animation)
  const prevPricesRef = useRef<Map<string, { yesBid: number | null; yesAsk: number | null; noBid: number | null; noAsk: number | null; yesPrice: number | null; bestBid: number | null; bestAsk: number | null }>>(new Map());

  // Track which cells are currently flashing
  const [flashingCells, setFlashingCells] = useState<Map<string, "up" | "down">>(new Map());

  // Live WS prices and status
  const {
    outcomes: liveOutcomes,
    connectionStatus: wsConnectionStatus,
    error: wsError,
  } = useLivePrices({
    kalshiUrl,
    pmUrl,
    capital,
    enabled: liveMode && !!kalshiUrl && !!pmUrl,
  });

  // Merge live WS prices with static outcomes.
  // When WS returns data, we MERGE it into the static outcomes rather than
  // replacing them entirely. If WS drops one side (e.g. PM prices null),
  // we fall back to the static outcome for that side. This prevents the
  // Polymarket column from disappearing when WS only returns Kalshi prices.
  const displayOutcomes = useMemo(() => {
    if (!liveMode || wsConnectionStatus !== "active" || liveOutcomes.length === 0) {
      return outcomes;
    }

    // Build a lookup of live outcomes by artist name
    const liveMap = new Map<string, typeof liveOutcomes[number]>();
    for (const lo of liveOutcomes) {
      liveMap.set(lo.artist, lo);
    }

    // Merge: start from static outcomes, overlay live data where available
    return outcomes.map(so => {
      const lo = liveMap.get(so.artist);
      if (!lo) return so; // no live data for this outcome, keep static

      return {
        artist: so.artist,
        // Use live platformA if available, otherwise fall back to static
        platformA: lo.platformA ?? so.platformA,
        // Use live platformB if available, otherwise fall back to static
        platformB: lo.platformB ?? so.platformB,
      };
    });
  }, [liveMode, wsConnectionStatus, liveOutcomes, outcomes]);

  // Detect price changes and trigger flash animations
  useEffect(() => {
    const newFlashes = new Map<string, "up" | "down">();
    const prev = prevPricesRef.current;

    displayOutcomes.forEach((o) => {
      if (!o.platformA || !o.platformB) return;
      const key = o.artist;
      const curr = o.platformA;
      const pm = o.platformB;
      const prevEntry = prev.get(key);

      // Check each price field
      const fields: Array<{ field: string; currentVal: number | null }> = [
        { field: `${key}-aYesBid`, currentVal: curr.yesBid },
        { field: `${key}-aYesAsk`, currentVal: curr.yesAsk },
        { field: `${key}-aNoBid`, currentVal: curr.noBid },
        { field: `${key}-aNoAsk`, currentVal: curr.noAsk },
        { field: `${key}-bYesPrice`, currentVal: pm.yesPrice },
        { field: `${key}-bBestBid`, currentVal: pm.bestBid },
        { field: `${key}-bBestAsk`, currentVal: pm.bestAsk },
      ];

      fields.forEach(({ field, currentVal }) => {
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
    type PrevEntry = { yesBid: number | null; yesAsk: number | null; noBid: number | null; noAsk: number | null; yesPrice: number | null; bestBid: number | null; bestAsk: number | null };
    const newPrev = new Map<string, PrevEntry>();
    displayOutcomes.forEach((o) => {
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
  }, [displayOutcomes]);

  // Compute spreads for all outcomes
  const spreads = useMemo(() => {
    const map = new Map<string, number | null>();
    displayOutcomes.forEach((o) => {
      if (o.platformA && o.platformB) {
        const ask = o.platformA.yesAsk;
        const yesPrice = o.platformB.yesPrice;
        if (ask == null || yesPrice == null) {
          map.set(o.artist, null);
        } else {
          map.set(o.artist, +(yesPrice - ask).toFixed(2));
        }
      }
    });
    return map;
  }, [displayOutcomes]);

  // Compute max volumes for depth normalization
  const maxVolumes = useMemo(() => {
    let maxBid = 0, maxAsk = 0;
    (displayOutcomes ?? []).forEach((o) => {
      if (o.platformA?.bidVolume) maxBid = Math.max(maxBid, o.platformA.bidVolume);
      if (o.platformA?.askVolume) maxBid = Math.max(maxBid, o.platformA.askVolume);
      if (o.platformB?.bidVolume) maxBid = Math.max(maxBid, o.platformB.bidVolume);
      if (o.platformB?.askVolume) maxBid = Math.max(maxBid, o.platformB.askVolume);
    });
    return { maxBid: maxBid || 1, maxAsk: maxAsk || 1 };
  }, [displayOutcomes]);

  const validOutcomes = (displayOutcomes ?? []).filter(
    (o) => o.platformA && o.platformB
  );

  // Check if any outcomes have null prices (CLOB timeout scenario)
  const allPricesNull = validOutcomes.length > 0 && validOutcomes.every(
    (o) => o.platformA!.yesBid == null && o.platformA!.yesAsk == null
  );

  if (validOutcomes.length === 0) {
    return (
      <div className="rounded-xl border border-[#232E3C] bg-[#0E1621] p-8 text-center">
        <p className="text-[#8A9BA8] text-sm">No matched outcomes to display.</p>
      </div>
    );
  }

  if (allPricesNull) {
    return (
      <div className="rounded-xl border border-[#232E3C] bg-[#0E1621] p-8 text-center">
        <p className="text-[#8A9BA8] text-sm">No live price data available for this market.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#232E3C] bg-[#0E1621] overflow-hidden">
      {/* ── Live WS Connection Status ── */}
      {liveMode && (
        <div className="border-b border-[#232E3C] bg-[#17212B]/60 px-3 py-1.5 flex items-center gap-2">
          <span className="text-[10px] text-[#8A9BA8]">Live WS:</span>
          {wsConnectionStatus === "connecting" && (
            <span className="flex items-center gap-1 text-[10px] text-[#facc15]">
              <RefreshCw className="w-3 h-3 animate-spin" /> Connecting...
            </span>
          )}
          {wsConnectionStatus === "active" && (
            <span className="flex items-center gap-1 text-[10px] text-[#5DBE81]">
              <div className="w-2 h-2 rounded-full bg-[#5DBE81] animate-pulse" /> Active
            </span>
          )}
          {wsConnectionStatus === "disconnected" && (
            <span className="flex items-center gap-1 text-[10px] text-[#ef4444]">
              <div className="w-2 h-2 rounded-full bg-[#ef4444]" /> Disconnected
            </span>
          )}
          {wsConnectionStatus === "idle" && (
            <span className="text-[10px] text-[#8A9BA8]">Idle</span>
          )}
          {wsError && (
            <span className="text-[10px] text-[#ef4444] ml-2">Error: {wsError}</span>
          )}
        </div>
      )}

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
            <span className="text-[9px] text-[#8A9BA8] uppercase text-center">
              Yes Bid
            </span>
            <span className="text-[9px] text-[#8A9BA8] uppercase text-center">
              Yes Ask
            </span>
          </div>
        </div>

        {/* Spread header */}
        <div className="col-auto px-1 py-2.5 text-center flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[#8A9BA8] font-medium">
            Spread
          </span>
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
            <span className="text-[9px] text-[#8A9BA8] uppercase text-center">
              Best Bid
            </span>
            <span className="text-[9px] text-[#8A9BA8] uppercase text-center">
              Best Ask
            </span>
          </div>
        </div>
      </div>

      {/* ── Outcome Rows ── */}
      <div className="divide-y divide-zinc-800">
        {validOutcomes.map((outcome: OutcomeEntry, oidx: number) => {
          const spread = spreads.get(outcome.artist) ?? null;
          const isHovered = hoveredRow === outcome.artist;
          const a = outcome.platformA!;
          const b = outcome.platformB!;

          // Flash states for each cell
          const flashAYesBid = flashingCells.get(`${outcome.artist}-aYesBid`) || null;
          const flashAYesAsk = flashingCells.get(`${outcome.artist}-aYesAsk`) || null;
          const flashANoBid = flashingCells.get(`${outcome.artist}-aNoBid`) || null;
          const flashANoAsk = flashingCells.get(`${outcome.artist}-aNoAsk`) || null;
          const flashBYesPrice = flashingCells.get(`${outcome.artist}-bYesPrice`) || null;
          const flashBBestBid = flashingCells.get(`${outcome.artist}-bBestBid`) || null;
          const flashBBestAsk = flashingCells.get(`${outcome.artist}-bBestAsk`) || null;

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
                      width: `${spread != null ? Math.min(Math.abs(spread) * 8, 100) : 0}%`,
                    }}
                  />
                </div>

                {/* Spread detail tooltip */}
                <div className="relative group">
                  <Info className="w-3 h-3 text-[#8A9BA8] cursor-help" />
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
                    flashDir={null}
                  />
                  <PriceCellWithFlash
                    value={b.noPrice}
                    cellKey={`${outcome.artist}-bNoAsk`}
                    isHovered={hoveredCell === `${outcome.artist}-bNoAsk`}
                    onHover={() => setHoveredCell(`${outcome.artist}-bNoAsk`)}
                    onLeave={() => setHoveredCell(null)}
                    lastUpdated={b.lastUpdated ?? lastUpdated}
                    flashDir={null}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Footer Legend ── */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-[#232E3C] bg-[#17212B]">
        <div className="flex items-center gap-4 text-[10px] text-[#8A9BA8]">
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
        <div className="text-[10px] text-[#8A9BA8]">
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
  value: number | null;
  cellKey: string;
  isHovered: boolean;
  onHover: () => void;
  onLeave: () => void;
  lastUpdated: Date | null | undefined;
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
