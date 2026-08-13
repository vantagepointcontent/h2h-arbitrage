// OverviewPanel.tsx — saved-markets overview table/grid (PERF-002 split from page.tsx).
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, Check, Clock, DollarSign, LayoutGrid, Loader2, Rows3, TrendingUp, Zap } from "lucide-react";
import { computeApy } from "@/lib/matcher";
import { OverviewSort, SavedMarket, formatPercent, formatCurrency, formatProfitDisplay, formatRelativeTime, isMarketExpired, getCanonicalMatchState, formatCanonicalMatchState } from "@/app/lib/page-shared";
import { ApyHeaderInfo, ApyValueTooltip, buildMarketTooltip, getDaysToExpiry } from "./ApyTooltip";
import { CompactStrategyDisplay } from "./ArbLegBreakdown";
import { DataTable } from "@/components/ui";
import { OpportunityQueue } from "./opportunities/OpportunityQueue";
import { buildOpportunityViewModel, rankOpportunities } from "./opportunities/opportunity-view-model";

const MARKET_SCAN_STALE_MS = 15 * 60_000;

function MarketFreshness({ scannedAt, refreshing, nowMs }: { scannedAt?: string | null; refreshing: boolean; nowMs: number }) {
  if (refreshing) {
    return <span className="inline-flex items-center justify-end gap-1 text-[var(--status-info)]"><Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />Refreshing</span>;
  }
  if (!scannedAt) return <span className="text-[var(--text-secondary)]">Not scanned</span>;
  const scannedMs = Date.parse(scannedAt);
  const stale = !Number.isFinite(scannedMs) || nowMs - scannedMs > MARKET_SCAN_STALE_MS;
  const age = formatRelativeTime(scannedAt);
  if (stale) {
    return <span className="inline-flex items-center justify-end gap-1 text-[var(--status-warning)]" title="Scan is more than 15 minutes old"><AlertTriangle aria-hidden="true" className="h-3 w-3" />Stale · {age}</span>;
  }
  return <span className="inline-flex items-center justify-end gap-1 text-[var(--text-secondary)]"><Check aria-hidden="true" className="h-3 w-3 text-[var(--status-positive)]" />Fresh · {age}</span>;
}

function MatchState({ market }: { market: SavedMarket }) {
  const state = getCanonicalMatchState(market);
  const label = formatCanonicalMatchState(market);
  const tone = state.status === "refreshing"
    ? "border-[var(--status-info)]/30 bg-[var(--status-info)]/10 text-[var(--status-info)]"
    : state.status === "unavailable"
      ? "border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 text-[var(--status-warning)]"
      : state.status === "matched"
        ? "border-[var(--border-strong)] bg-[var(--surface-hover)] text-[var(--text-primary)]"
        : "border-[var(--border-subtle)] bg-[var(--surface-workspace)] text-[var(--text-secondary)]";
  return (
    <span className={`inline-flex max-w-40 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${tone}`} title={label}>
      {state.status === "refreshing" && <Loader2 aria-hidden="true" className="h-2.5 w-2.5 shrink-0 animate-spin" />}
      {state.status === "unavailable" && <AlertTriangle aria-hidden="true" className="h-2.5 w-2.5 shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  );
}

/* ── Overview Panel ── */
function OverviewPanelInner({
  markets,
  loading,
  onLoad,
  sort,
  sortDir,
  onToggleSort,
  layout,
  onToggleLayout,
  expiryFilter,
  onSetExpiryFilter,
  showArbOnly,
  onToggleShowArbOnly,
  showExpired,
  onToggleShowExpired,
  timeUntilExpiry,
  formatExpiry,
  onSelectMarket,
  mode = "markets",
}: {
  markets: SavedMarket[];
  loading: boolean;
  onLoad: () => void;
  sort: OverviewSort;
  sortDir: "asc" | "desc";
  onToggleSort: (f: OverviewSort) => void;
  layout: "grid" | "table";
  onToggleLayout: (l: "grid" | "table") => void;
  expiryFilter: "all" | "lte7" | "lte14" | "lte30";
  onSetExpiryFilter: (f: "all" | "lte7" | "lte14" | "lte30") => void;
  showArbOnly: boolean;
  onToggleShowArbOnly: () => void;
  showExpired: boolean;
  onToggleShowExpired: () => void;
  timeUntilExpiry: (iso?: string | null) => string;
  formatExpiry: (iso?: string | null) => string;
  onSelectMarket: (m: SavedMarket) => void;
  mode?: "markets" | "opportunities";
}) {
  // Auto-load on mount only — prevents infinite loop if parent re-creates callback
  useEffect(() => { onLoad(); }, []);
  const [renderedAt] = useState(() => Date.now());

  const getMarketApy = (m: SavedMarket): number => {
    const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
    return computeApy(roi, m.expiryDate);
  };

  // Helper: check if a market's numeric value is missing (shows as "—")
  const hasNoValue = (m: SavedMarket, field: OverviewSort): boolean => {
    switch (field) {
      case "roi": return (m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0) === 0;
      case "apy": return getMarketApy(m) === 0;
      case "profit": return (m.liveResult?.bestProfit ?? m.lastScanResult?.bestProfit ?? 0) === 0;
      case "matched": return getCanonicalMatchState(m).status === 'not_scanned';
      case "arbs": {
        const allArbs = m.liveResult?.allArbs ?? m.lastScanResult?.allArbs;
        const cnt = allArbs ? allArbs.filter(a => a.expectedProfit > 0).length : 0;
        return cnt === 0;
      }
      case "scanned": return !(m.liveResult?.scannedAt ?? m.lastScanResult?.scannedAt);
      default: return false;
    }
  };

  const sortFn = (a: SavedMarket, b: SavedMarket) => {
    const mul = sortDir === "asc" ? 1 : -1;
    // For numeric columns: rows with "—" (no data) always sort to bottom
    const numericFields: OverviewSort[] = ["roi", "apy", "profit", "matched", "arbs", "scanned"];
    if (numericFields.includes(sort)) {
      const aEmpty = hasNoValue(a, sort);
      const bEmpty = hasNoValue(b, sort);
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;   // a goes to bottom
      if (bEmpty) return -1;  // b goes to bottom
    }
    if (sort === "name") return mul * a.eventTitle.localeCompare(b.eventTitle);
    if (sort === "strategy") {
      const sa = a.liveResult?.strategy ?? a.lastScanResult?.strategy ?? "";
      const sb = b.liveResult?.strategy ?? b.lastScanResult?.strategy ?? "";
      return mul * sa.localeCompare(sb);
    }
    if (sort === "expiry") {
      const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
      const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
      return mul * (ea - eb);
    }
    if (sort === "roi") {
      const ra = a.liveResult?.bestRoiPct ?? a.lastScanResult?.bestRoiPct ?? 0;
      const rb = b.liveResult?.bestRoiPct ?? b.lastScanResult?.bestRoiPct ?? 0;
      return mul * (ra - rb);
    }
    if (sort === "apy") {
      return mul * (getMarketApy(a) - getMarketApy(b));
    }
    if (sort === "profit") {
      const pa = a.liveResult?.bestProfit ?? a.lastScanResult?.bestProfit ?? 0;
      const pb = b.liveResult?.bestProfit ?? b.lastScanResult?.bestProfit ?? 0;
      return mul * (pa - pb);
    }
    if (sort === "matched") {
      const ma = getCanonicalMatchState(a).count;
      const mb = getCanonicalMatchState(b).count;
      return mul * (ma - mb);
    }
    if (sort === "arbs") {
      const aa = a.liveResult?.allArbs ?? a.lastScanResult?.allArbs;
      const ab = b.liveResult?.allArbs ?? b.lastScanResult?.allArbs;
      const ca = aa ? aa.filter(x => x.expectedProfit > 0).length : 0;
      const cb = ab ? ab.filter(x => x.expectedProfit > 0).length : 0;
      return mul * (ca - cb);
    }
    if (sort === "scanned") {
      const ta = new Date(a.liveResult?.scannedAt ?? a.lastScanResult?.scannedAt ?? 0).getTime() || 0;
      const tb = new Date(b.liveResult?.scannedAt ?? b.lastScanResult?.scannedAt ?? 0).getTime() || 0;
      return mul * (ta - tb);
    }
    return 0;
  };

  // PERF-P0: memoize sort/filter pipelines + aggregates (400+ markets)
  const sorted = useMemo(() => [...markets].sort(sortFn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markets, sort, sortDir]);

  const [categoryFilter, setCategoryFilter] = useState("all");

  // Categories are derived from the saved market data so the control stays current
  // without maintaining a second taxonomy in the UI.
  const categories = useMemo(() => [...new Set(
    markets
      .map((market) => market.category?.trim())
      .filter((category): category is string => Boolean(category)),
  )].sort((a, b) => a.localeCompare(b)), [markets]);

  // Apply category, expiry, and arb filters as one memoized pipeline.
  const filteredByExpiry = useMemo(() => [...markets].filter(m => {
    if (categoryFilter !== "all") {
      const category = m.category?.trim().toLocaleLowerCase() || "uncategorized";
      if (category !== categoryFilter) return false;
    }
    if (categoryFilter === "uncategorized" && m.category?.trim()) return false;
    return true;
  }).filter(m => {
    if (!showExpired) {
      // BUG-05b2: use smart expiry — in-play markets (trading prices) are NOT expired
      const isExpired = isMarketExpired(m);
      if (isExpired) return false;
    }
    if (expiryFilter === "all") return true;
    if (!m.expiryDate) return false;
    const days = (new Date(m.expiryDate).getTime() - renderedAt) / 86400000;
    if (expiryFilter === "lte7") return days <= 7;
    if (expiryFilter === "lte14") return days <= 14;
    if (expiryFilter === "lte30") return days <= 30;
    return true;
  }).filter(m => {
    if (!showArbOnly) return true;
    const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
    return roi > 0;
  }).sort(sortFn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markets, categoryFilter, showExpired, expiryFilter, showArbOnly, sort, sortDir, renderedAt]);

  // Aggregate stats (respect current filter)
  const { totalMarkets, totalProfit, avgRoi, arbOpportunities } = useMemo(() => {
    const totalMarkets = filteredByExpiry.length;
    const totalProfit = filteredByExpiry.reduce((sum, m) => {
      const p = m.liveResult?.bestProfit ?? m.lastScanResult?.bestProfit ?? 0;
      return sum + (p > 0 ? p : 0);
    }, 0);
    const avgRoi = totalMarkets > 0 ? filteredByExpiry.reduce((sum, m) => sum + (m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0), 0) / totalMarkets : 0;
    const arbOpportunities = filteredByExpiry.filter(m => (m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0) > 0).length;
    return { totalMarkets, totalProfit, avgRoi, arbOpportunities };
  }, [filteredByExpiry]);

  const opportunityModels = useMemo(() => rankOpportunities(markets.flatMap((market) => {
    const scan = market.liveResult ?? market.lastScanResult;
    const historicalArbs = market.lastScanResult?.allArbs ?? [];
    const liveArbs = market.liveResult?.allArbs ?? [];
    const opportunityKey = (arb: { artist: string; strategy: string }) => `${arb.artist}::${arb.strategy}`;
    const liveKeys = new Set(liveArbs.map(opportunityKey));
    const historicalKeys = new Set(historicalArbs.map(opportunityKey));
    const arbs = [
      ...historicalArbs.filter((arb) => liveKeys.has(opportunityKey(arb))),
      ...liveArbs.filter((arb) => !historicalKeys.has(opportunityKey(arb))),
      ...historicalArbs.filter((arb) => !liveKeys.has(opportunityKey(arb))),
    ];
    return arbs
      .filter((arb) => arb.expectedProfit > 0 && arb.roiPct > 0)
      .map((arb) => buildOpportunityViewModel({
        artist: arb.artist,
        kalshi: {
          ticker: "kalshiTicker" in arb && typeof arb.kalshiTicker === "string" ? arb.kalshiTicker : undefined,
          yesAsk: "kalshiYesAsk" in arb && typeof arb.kalshiYesAsk === "number" ? arb.kalshiYesAsk : 0,
          noAsk: "kalshiNoAsk" in arb && typeof arb.kalshiNoAsk === "number" ? arb.kalshiNoAsk : 0,
        },
        polymarket: {
          conditionId: "pmConditionId" in arb && typeof arb.pmConditionId === "string" ? arb.pmConditionId : undefined,
          yesPrice: "pmYesPrice" in arb && typeof arb.pmYesPrice === "number" ? arb.pmYesPrice : 0,
          noPrice: "pmNoPrice" in arb && typeof arb.pmNoPrice === "number" ? arb.pmNoPrice : 0,
        },
        arbitrage: {
          strategy: arb.strategy,
          expectedProfit: arb.expectedProfit,
          roiPct: arb.roiPct,
          kalshiStake: "kalshiStake" in arb && typeof arb.kalshiStake === "number" ? arb.kalshiStake : undefined,
          pmStake: "pmStake" in arb && typeof arb.pmStake === "number" ? arb.pmStake : undefined,
          maxCapital: arb.totalStake,
        },
        persistence: liveKeys.has(opportunityKey(arb)) && historicalKeys.has(opportunityKey(arb))
          ? "durable"
          : liveKeys.has(opportunityKey(arb))
            ? "new"
            : "fading",
      }, {
        marketId: market.id,
        marketTitle: market.eventTitle,
        scannedAt: scan?.scannedAt,
      }));
  })), [markets]);

  if (mode === "opportunities") {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold tracking-tight">Opportunity Queue</h2>
        </div>
        {opportunityModels.length > 0 ? (
          <div className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)]">
            <OpportunityQueue
              opportunities={opportunityModels}
              onPrepare={(opportunity) => {
                const market = markets.find((item) => item.id === opportunity.marketId);
                if (market) onSelectMarket(market);
              }}
            />
          </div>
        ) : (
          <div className="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface-panel)] p-8 text-center text-sm text-[var(--text-secondary)]">
            No actionable opportunities right now.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Aggregate Stats Bar ── */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
          <TrendingUp className={`w-3 h-3 ${avgRoi > 0 ? "text-[var(--status-positive)]" : avgRoi < 0 ? "text-[var(--status-negative)]" : "text-[var(--text-secondary)]"}`} />
          <span className="text-[10px] text-[var(--text-secondary)]">Avg Yield</span>
          <span className={`text-xs font-bold ${avgRoi > 0 ? "text-[var(--status-positive)]" : avgRoi < 0 ? "text-[var(--status-negative)]" : "text-[var(--text-secondary)]"}`}>{avgRoi > 0 ? "+" : ""}{formatPercent(avgRoi)}</span>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
          <DollarSign className={`w-3 h-3 ${totalProfit > 0 ? "text-[var(--status-positive)]" : totalProfit < 0 ? "text-[var(--status-negative)]" : "text-[var(--text-secondary)]"}`} />
          <span className="text-[10px] text-[var(--text-secondary)]">Total Profit</span>
          <span className={`text-xs font-bold ${totalProfit > 0 ? "text-[var(--status-positive)]" : totalProfit < 0 ? "text-[var(--status-negative)]" : "text-[var(--text-secondary)]"}`}>{formatCurrency(totalProfit)}</span>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
          <Zap className="w-3 h-3 text-[var(--status-warning)]" />
          <span className="text-[10px] text-[var(--text-secondary)]">Arbitrages</span>
          <span className="text-xs font-bold text-[var(--text-primary)]">{arbOpportunities} / {totalMarkets}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <h2 className="text-xl font-bold tracking-tight">Markets</h2>
        <div className="flex items-center gap-2 overflow-x-auto pb-1 xl:pb-0">
          <div className="flex items-center gap-1 bg-[var(--surface-hover)] rounded-lg px-1.5 py-0.5">
            <label htmlFor="market-category-filter" className="sr-only">Category</label>
            <select
              id="market-category-filter"
              aria-label="Category"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              className="max-w-32 bg-transparent px-1 py-1 text-[10px] font-medium text-[var(--text-secondary)] outline-none hover:text-[var(--text-primary)]"
            >
              <option value="all">All categories</option>
              {categories.map((category) => (
                <option key={category} value={category.toLocaleLowerCase()}>{category}</option>
              ))}
              <option value="uncategorized">Uncategorized</option>
            </select>
          </div>
          <div className="w-px h-4 bg-[var(--border-strong)]" />
          <div className="flex items-center gap-1 bg-[var(--surface-hover)] rounded-lg p-0.5">
            <button
              onClick={() => onToggleShowArbOnly()}
              className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                showArbOnly
                  ? "bg-[var(--status-positive)]/20 text-[var(--status-positive)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
              title={showArbOnly ? "Show all markets" : "Show only arbitrage opportunities"}
            >
              {showArbOnly ? "Arb: On" : "Arb: Off"}
            </button>
          </div>
          <div className="flex items-center gap-1 bg-[var(--surface-hover)] rounded-lg p-0.5">
            <button
              onClick={() => onToggleShowExpired()}
              className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                showExpired
                  ? "bg-[var(--status-positive)]/20 text-[var(--status-positive)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
              title={showExpired ? "Click to hide expired markets" : "Expired markets are hidden — click to show them"}
            >
              {showExpired ? "Showing expired" : "Expired hidden"}
            </button>
          </div>
          <div className="w-px h-4 bg-[var(--border-strong)]" />
          {/* Expiry filter buttons */}
          <div className="flex items-center gap-1 bg-[var(--surface-hover)] rounded-lg p-0.5">
            {([
              { key: "all", label: "All" },
              { key: "lte7", label: "≤7d" },
              { key: "lte14", label: "≤14d" },
              { key: "lte30", label: "≤30d" },
            ] as { key: typeof expiryFilter; label: string }[]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => onSetExpiryFilter(key)}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                  expiryFilter === key
                    ? "bg-[var(--status-positive)]/20 text-[var(--status-positive)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="w-px h-4 bg-[var(--border-strong)]" />
          {/* Sort toggles */}
          <div className="flex items-center gap-1 bg-[var(--surface-hover)] rounded-lg p-0.5">
            {([
              { key: "apy", label: "APY" },
              { key: "roi", label: "ROI" },
              { key: "profit", label: "PROFIT" },
              { key: "expiry", label: "EXP" },
              { key: "name", label: "NAME" },
              { key: "scanned", label: "SCANNED" },
            ] as { key: OverviewSort; label: string }[]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => onToggleSort(key)}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                  sort === key
                    ? "bg-[var(--status-positive)]/20 text-[var(--status-positive)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {label}{sort === key && (sortDir === "asc" ? " ↑" : " ↓")}
              </button>
            ))}
          </div>
          <div className="w-px h-4 bg-[var(--border-strong)]" />
          <button onClick={() => onToggleLayout(layout === "grid" ? "table" : "grid")} className="p-2 rounded-lg bg-[var(--surface-hover)] hover:bg-[var(--border-strong)] text-[var(--text-secondary)] transition-colors" title="Toggle layout">
            {layout === "grid" ? <Rows3 className="w-4 h-4" /> : <LayoutGrid className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-20 text-center text-sm text-[var(--text-secondary)]">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
          Loading markets...
        </div>
      ) : filteredByExpiry.length === 0 ? (
        <div className="py-20 text-center text-sm text-[var(--text-secondary)]">
          {sorted.length === 0 ? "No saved markets. Go to Scan or MarketFinder to add some." : "No markets match the selected expiry filter."}
        </div>
      ) : layout === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredByExpiry.map((m) => {
            const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
            const apy = getMarketApy(m);
            const profit = m.liveResult?.bestProfit ?? m.lastScanResult?.bestProfit ?? 0;
            const allArbs = m.liveResult?.allArbs ?? m.lastScanResult?.allArbs;
            const matchedLabel = formatCanonicalMatchState(m);
            const arbCount = allArbs ? allArbs.filter(a => a.expectedProfit > 0).length : 0;
            const scannedAt = m.liveResult?.scannedAt ?? m.lastScanResult?.scannedAt;
            return (
              <div
                key={m.id}
                onClick={() => onSelectMarket(m)}
                className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4 space-y-3 cursor-pointer hover:border-[var(--status-positive)]/40 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <h3 className="font-semibold text-sm text-[var(--text-primary)]" title={buildMarketTooltip({ eventTitle: m.eventTitle, expiryDate: m.expiryDate, category: m.category, scannedAt: scannedAt })}>{m.eventTitle}</h3>
                  <div className="flex items-center gap-1.5">
                    {arbCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--status-positive)]/10 text-[var(--status-positive)] font-medium">{arbCount} arb{arbCount > 1 ? "s" : ""}</span>}
                    {m.category && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--surface-hover)] text-[var(--text-secondary)]">{m.category}</span>}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="text-[var(--text-secondary)]">Expiry</div>
                  <div className="text-[var(--text-primary)] text-right">{formatExpiry(m.expiryDate)}</div>
                  <div className="text-[var(--text-secondary)]">Matched</div>
                  <div className="text-[var(--text-secondary)] text-right">{matchedLabel}</div>
                  <div className="text-[var(--text-secondary)]">ROI</div>
                  <div className={`text-right font-bold ${roi > 0 ? "text-[var(--status-positive)]" : roi < 0 ? "text-[var(--status-negative)]" : "text-[var(--text-secondary)]"}`}>
                    {roi !== 0 ? `${roi > 0 ? "+" : ""}${formatPercent(roi)}` : "—"}
                  </div>
                  <div className="text-[var(--text-secondary)] inline-flex items-center gap-1">APY <ApyHeaderInfo /></div>
                  <div className={`text-right font-bold ${apy > 0 ? "text-[var(--status-positive)]" : apy < 0 ? "text-[var(--status-negative)]" : "text-[var(--text-secondary)]"}`}>
                    {apy !== 0 ? (
                      <ApyValueTooltip apy={apy} roi={roi} daysToExpiry={getDaysToExpiry(m.expiryDate)}>
                        {`${apy > 0 ? "+" : ""}${formatPercent(apy)}`}
                      </ApyValueTooltip>
                    ) : "—"}
                  </div>
                  <div className="text-[var(--text-secondary)]">Est. Profit</div>
                  <div className="text-[var(--text-primary)] text-right">{profit !== 0 ? formatProfitDisplay(profit, allArbs) : "—"}</div>
                </div>
                <div className="flex items-center justify-between text-[10px] text-[var(--text-secondary)]">
                  <div className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {timeUntilExpiry(m.expiryDate)}
                  </div>
                  <span>{formatRelativeTime(scannedAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div data-testid="markets-table-scroll" className="overflow-x-auto rounded-xl border border-[var(--border-strong)] bg-[var(--table-row-surface)] shadow-[0_10px_30px_rgba(0,0,0,0.12)]">
          <DataTable aria-label="Saved markets overview" className="min-w-[960px] [&_td]:h-10 [&_td]:px-3 [&_td]:py-1.5">
            <thead className="sticky top-0 z-10 border-b border-[var(--border-strong)] bg-[var(--table-header-surface)] shadow-[0_1px_0_var(--border-strong)]">
              <tr className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wider">
                {([
                  { key: "name", label: "Market", align: "left" },
                  { key: "expiry", label: "Expiry", align: "right" },
                  { key: "matched", label: "Matched", align: "right" },
                  { key: "arbs", label: "Arbs", align: "right" },
                  { key: "roi", label: "ROI", align: "right" },
                  { key: "apy", label: "APY", align: "right", info: true },
                  { key: "profit", label: "Profit", align: "right" },
                  { key: "strategy", label: "Strategy", align: "left" },
                  { key: "scanned", label: "Scanned", align: "right" },
                ] as { key: OverviewSort; label: string; align: "left" | "right"; info?: boolean }[]).map(({ key, label, align, info }) => (
                  <th
                    key={key}
                    onClick={() => onToggleSort(key)}
                    className={`whitespace-nowrap px-3 py-2 font-semibold cursor-pointer select-none hover:text-[var(--text-primary)] transition-colors ${align === "right" ? "text-right" : "text-left"}`}
                  >
                    <span className={align === "right" ? "inline-flex items-center gap-1 flex-row-reverse" : "inline-flex items-center gap-1"}>
                      {label}
                      {info && <ApyHeaderInfo />}
                      <span className={`text-[10px] transition-opacity ${sort === key ? "opacity-100 text-[var(--status-positive)]" : "opacity-0"}`}>
                        {sort === key && sortDir === "asc" ? "▲" : "▼"}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredByExpiry.map((m) => {
                const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
                const apy = getMarketApy(m);
                const profit = m.liveResult?.bestProfit ?? m.lastScanResult?.bestProfit ?? 0;
                const allArbs = m.liveResult?.allArbs ?? m.lastScanResult?.allArbs;
                const strategy = m.liveResult?.strategy ?? m.lastScanResult?.strategy ?? "";
                const matchState = getCanonicalMatchState(m);
                const arbCount = allArbs ? allArbs.filter(a => a.expectedProfit > 0).length : 0;
                const scannedAt = m.liveResult?.scannedAt ?? m.lastScanResult?.scannedAt;
                return (
                  <tr
                    key={m.id}
                    onClick={() => onSelectMarket(m)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectMarket(m);
                      }
                    }}
                    tabIndex={0}
                    className="group cursor-pointer bg-[var(--table-row-surface)] transition-[background-color,box-shadow] odd:bg-[var(--table-row-alternate)] hover:bg-[var(--table-row-hover)] focus-visible:bg-[var(--table-row-focus)] focus-visible:outline-none focus-visible:shadow-[inset_3px_0_var(--focus-ring),inset_0_0_0_1px_var(--focus-ring)]"
                  >
                    <td className="max-w-[360px]" title={buildMarketTooltip({ eventTitle: m.eventTitle, expiryDate: m.expiryDate, category: m.category, scannedAt })}>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-semibold text-[var(--text-primary)]">{m.eventTitle}</span>
                        {m.category && <span className="shrink-0 rounded border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--text-secondary)]">{m.category}</span>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-right text-[var(--text-secondary)]">{formatExpiry(m.expiryDate)}</td>
                    <td className="text-right"><MatchState market={m} /></td>
                    <td className="text-right">
                      {arbCount > 0 ? <span aria-label={`${arbCount} active arbitrage ${arbCount === 1 ? "opportunity" : "opportunities"}`} className="inline-flex min-w-6 items-center justify-center gap-1 rounded-md border border-[var(--status-positive)]/30 bg-[var(--status-positive)]/10 px-1.5 py-0.5 font-bold text-[var(--status-positive)]"><Zap aria-hidden="true" className="h-2.5 w-2.5" />{arbCount}</span> : <span className="text-[var(--text-secondary)]">—</span>}
                    </td>
                    <td className={`text-right font-bold ${roi > 0 ? "text-[var(--status-positive)]" : roi < 0 ? "text-[var(--status-negative)]" : "text-[var(--text-secondary)]"}`}>
                      {roi !== 0 ? `${roi > 0 ? "+" : ""}${formatPercent(roi)}` : "—"}
                    </td>
                    <td className={`text-right font-bold ${apy > 0 ? "text-[var(--status-positive)]" : apy < 0 ? "text-[var(--status-negative)]" : "text-[var(--text-secondary)]"}`}>
                      {apy !== 0 ? (
                        <ApyValueTooltip apy={apy} roi={roi} daysToExpiry={getDaysToExpiry(m.expiryDate)}>
                          {`${apy > 0 ? "+" : ""}${formatPercent(apy)}`}
                        </ApyValueTooltip>
                      ) : "—"}
                    </td>
                    <td className={`whitespace-nowrap text-right font-semibold ${profit > 0 ? "text-[var(--status-positive)]" : profit < 0 ? "text-[var(--status-negative)]" : "text-[var(--text-secondary)]"}`}>{profit !== 0 ? formatProfitDisplay(profit, allArbs) : "—"}</td>
                    <td className="whitespace-nowrap text-xs"><CompactStrategyDisplay strategy={strategy} /></td>
                    <td className="whitespace-nowrap text-right text-[10px]"><MarketFreshness scannedAt={scannedAt} refreshing={matchState.status === "refreshing"} nowMs={renderedAt} /></td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </div>
      )}
    </div>
  );
}

// PERF-P0: memoized export — skip re-render when props are shallow-equal
export const OverviewPanel = React.memo(OverviewPanelInner);
