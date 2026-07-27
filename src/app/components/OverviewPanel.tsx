// OverviewPanel.tsx — saved-markets overview table/grid (PERF-002 split from page.tsx).
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Clock, DollarSign, LayoutGrid, Loader2, Rows3, TrendingUp, Zap } from "lucide-react";
import { computeApy } from "@/lib/matcher";
import { OverviewSort, SavedMarket, formatPercent, formatCurrency, formatProfitDisplay, formatRelativeTime, isMarketExpired } from "@/app/lib/page-shared";
import { ApyHeaderInfo, ApyValueTooltip, buildMarketTooltip, getDaysToExpiry } from "./ApyTooltip";
import { CompactStrategyDisplay } from "./ArbLegBreakdown";

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
}) {
  // Auto-load on mount only — prevents infinite loop if parent re-creates callback
  useEffect(() => { onLoad(); }, []);

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
      case "matched": return (m.liveResult?.matchedCount ?? m.lastScanResult?.matchedCount ?? 0) === 0;
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
      const ma = a.liveResult?.matchedCount ?? a.lastScanResult?.matchedCount ?? 0;
      const mb = b.liveResult?.matchedCount ?? b.lastScanResult?.matchedCount ?? 0;
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
    const days = (new Date(m.expiryDate).getTime() - Date.now()) / 86400000;
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
    [markets, categoryFilter, showExpired, expiryFilter, showArbOnly, sort, sortDir]);

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

  return (
    <div className="space-y-5">
      {/* ── Aggregate Stats Bar ── */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#182533] bg-[#121E2B]">
          <TrendingUp className={`w-3 h-3 ${avgRoi > 0 ? "text-[#5DBE81]" : avgRoi < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]"}`} />
          <span className="text-[10px] text-[#8A9BA8]">Avg Yield</span>
          <span className={`text-xs font-bold ${avgRoi > 0 ? "text-[#5DBE81]" : avgRoi < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]"}`}>{avgRoi > 0 ? "+" : ""}{formatPercent(avgRoi)}</span>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#182533] bg-[#121E2B]">
          <DollarSign className={`w-3 h-3 ${totalProfit > 0 ? "text-[#5DBE81]" : totalProfit < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]"}`} />
          <span className="text-[10px] text-[#8A9BA8]">Total Profit</span>
          <span className={`text-xs font-bold ${totalProfit > 0 ? "text-[#5DBE81]" : totalProfit < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]"}`}>{formatCurrency(totalProfit)}</span>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#182533] bg-[#121E2B]">
          <Zap className="w-3 h-3 text-[#facc15]" />
          <span className="text-[10px] text-[#8A9BA8]">Arbitrages</span>
          <span className="text-xs font-bold text-[#FFFFFF]">{arbOpportunities} / {totalMarkets}</span>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold tracking-tight">Markets</h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-[#182533] rounded-lg px-1.5 py-0.5">
            <label htmlFor="market-category-filter" className="sr-only">Category</label>
            <select
              id="market-category-filter"
              aria-label="Category"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              className="max-w-32 bg-transparent px-1 py-1 text-[10px] font-medium text-[#8A9BA8] outline-none hover:text-[#FFFFFF]"
            >
              <option value="all">All categories</option>
              {categories.map((category) => (
                <option key={category} value={category.toLocaleLowerCase()}>{category}</option>
              ))}
              <option value="uncategorized">Uncategorized</option>
            </select>
          </div>
          <div className="w-px h-4 bg-[#232E3C]" />
          <div className="flex items-center gap-1 bg-[#182533] rounded-lg p-0.5">
            <button
              onClick={() => onToggleShowArbOnly()}
              className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                showArbOnly
                  ? "bg-[#5DBE81]/20 text-[#5DBE81]"
                  : "text-[#8A9BA8] hover:text-[#FFFFFF]"
              }`}
              title={showArbOnly ? "Show all markets" : "Show only arbitrage opportunities"}
            >
              {showArbOnly ? "Arb: On" : "Arb: Off"}
            </button>
          </div>
          <div className="flex items-center gap-1 bg-[#182533] rounded-lg p-0.5">
            <button
              onClick={() => onToggleShowExpired()}
              className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                showExpired
                  ? "bg-[#5DBE81]/20 text-[#5DBE81]"
                  : "text-[#8A9BA8] hover:text-[#FFFFFF]"
              }`}
              title={showExpired ? "Click to hide expired markets" : "Expired markets are hidden — click to show them"}
            >
              {showExpired ? "Showing expired" : "Expired hidden"}
            </button>
          </div>
          <div className="w-px h-4 bg-[#232E3C]" />
          {/* Expiry filter buttons */}
          <div className="flex items-center gap-1 bg-[#182533] rounded-lg p-0.5">
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
                    ? "bg-[#5DBE81]/20 text-[#5DBE81]"
                    : "text-[#8A9BA8] hover:text-[#FFFFFF]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="w-px h-4 bg-[#232E3C]" />
          {/* Sort toggles */}
          <div className="flex items-center gap-1 bg-[#182533] rounded-lg p-0.5">
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
                    ? "bg-[#5DBE81]/20 text-[#5DBE81]"
                    : "text-[#8A9BA8] hover:text-[#FFFFFF]"
                }`}
              >
                {label}{sort === key && (sortDir === "asc" ? " ↑" : " ↓")}
              </button>
            ))}
          </div>
          <div className="w-px h-4 bg-[#232E3C]" />
          <button onClick={() => onToggleLayout(layout === "grid" ? "table" : "grid")} className="p-2 rounded-lg bg-[#182533] hover:bg-[#232E3C] text-[#8A9BA8] transition-colors" title="Toggle layout">
            {layout === "grid" ? <Rows3 className="w-4 h-4" /> : <LayoutGrid className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-20 text-center text-sm text-[#8A9BA8]">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
          Loading markets...
        </div>
      ) : filteredByExpiry.length === 0 ? (
        <div className="py-20 text-center text-sm text-[#8A9BA8]">
          {sorted.length === 0 ? "No saved markets. Go to Scan or MarketFinder to add some." : "No markets match the selected expiry filter."}
        </div>
      ) : layout === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredByExpiry.map((m) => {
            const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
            const apy = getMarketApy(m);
            const profit = m.liveResult?.bestProfit ?? m.lastScanResult?.bestProfit ?? 0;
            const allArbs = m.liveResult?.allArbs ?? m.lastScanResult?.allArbs;
            const matchedCount = m.liveResult?.matchedCount ?? m.lastScanResult?.matchedCount ?? 0;
            const arbCount = allArbs ? allArbs.filter(a => a.expectedProfit > 0).length : 0;
            const scannedAt = m.liveResult?.scannedAt ?? m.lastScanResult?.scannedAt;
            return (
              <div
                key={m.id}
                onClick={() => onSelectMarket(m)}
                className="rounded-xl border border-[#182533] bg-[#17212B] p-4 space-y-3 cursor-pointer hover:border-[#5DBE81]/40 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <h3 className="font-semibold text-sm text-[#FFFFFF]" title={buildMarketTooltip({ eventTitle: m.eventTitle, expiryDate: m.expiryDate, category: m.category, scannedAt: scannedAt })}>{m.eventTitle}</h3>
                  <div className="flex items-center gap-1.5">
                    {arbCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#5DBE81]/10 text-[#5DBE81] font-medium">{arbCount} arb{arbCount > 1 ? "s" : ""}</span>}
                    {m.category && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#182533] text-[#8A9BA8]">{m.category}</span>}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="text-[#8A9BA8]">Expiry</div>
                  <div className="text-[#FFFFFF] text-right">{formatExpiry(m.expiryDate)}</div>
                  <div className="text-[#8A9BA8]">Matched</div>
                  <div className="text-[#8A9BA8] text-right">{matchedCount > 0 ? matchedCount : "—"}</div>
                  <div className="text-[#8A9BA8]">ROI</div>
                  <div className={`text-right font-bold ${roi > 0 ? "text-[#5DBE81]" : roi < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]"}`}>
                    {roi !== 0 ? `${roi > 0 ? "+" : ""}${formatPercent(roi)}` : "—"}
                  </div>
                  <div className="text-[#8A9BA8] inline-flex items-center gap-1">APY <ApyHeaderInfo /></div>
                  <div className={`text-right font-bold ${apy > 0 ? "text-[#5DBE81]" : apy < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]"}`}>
                    {apy !== 0 ? (
                      <ApyValueTooltip apy={apy} roi={roi} daysToExpiry={getDaysToExpiry(m.expiryDate)}>
                        {`${apy > 0 ? "+" : ""}${formatPercent(apy)}`}
                      </ApyValueTooltip>
                    ) : "—"}
                  </div>
                  <div className="text-[#8A9BA8]">Est. Profit</div>
                  <div className="text-[#FFFFFF] text-right">{profit !== 0 ? formatProfitDisplay(profit, allArbs) : "—"}</div>
                </div>
                <div className="flex items-center justify-between text-[10px] text-[#8A9BA8]">
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
        <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#17212B] border-b border-[#182533]">
              <tr className="text-[10px] text-[#8A9BA8] uppercase tracking-wider">
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
                    className={`px-4 py-3 font-medium cursor-pointer select-none hover:text-[#FFFFFF] transition-colors ${align === "right" ? "text-right" : "text-left"}`}
                  >
                    <span className={align === "right" ? "inline-flex items-center gap-1 flex-row-reverse" : "inline-flex items-center gap-1"}>
                      {label}
                      {info && <ApyHeaderInfo />}
                      <span className={`text-[8px] transition-opacity ${sort === key ? "opacity-100 text-[#5DBE81]" : "opacity-0"}`}>
                        {sort === key && sortDir === "asc" ? "▲" : "▼"}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#182533]">
              {filteredByExpiry.map((m) => {
                const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
                const apy = getMarketApy(m);
                const profit = m.liveResult?.bestProfit ?? m.lastScanResult?.bestProfit ?? 0;
                const allArbs = m.liveResult?.allArbs ?? m.lastScanResult?.allArbs;
                const strategy = m.liveResult?.strategy ?? m.lastScanResult?.strategy ?? "";
                const matchedCount = m.liveResult?.matchedCount ?? m.lastScanResult?.matchedCount ?? 0;
                const arbCount = allArbs ? allArbs.filter(a => a.expectedProfit > 0).length : 0;
                const scannedAt = m.liveResult?.scannedAt ?? m.lastScanResult?.scannedAt;
                return (
                  <tr
                    key={m.id}
                    onClick={() => onSelectMarket(m)}
                    className="cursor-pointer hover:bg-[#182533]/50 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-[#FFFFFF]" title={buildMarketTooltip({ eventTitle: m.eventTitle, expiryDate: m.expiryDate, category: m.category, scannedAt })}>{m.eventTitle}</td>
                    <td className="px-4 py-3 text-right text-[#FFFFFF]">{formatExpiry(m.expiryDate)}</td>
                    <td className="px-4 py-3 text-right text-[#8A9BA8]">{matchedCount > 0 ? matchedCount : "—"}</td>
                    <td className="px-4 py-3 text-right font-bold text-[#5DBE81]">{arbCount > 0 ? arbCount : "—"}</td>
                    <td className={`px-4 py-3 text-right font-bold ${roi > 0 ? "text-[#5DBE81]" : roi < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]"}`}>
                      {roi !== 0 ? `${roi > 0 ? "+" : ""}${formatPercent(roi)}` : "—"}
                    </td>
                    <td className={`px-4 py-3 text-right font-bold ${apy > 0 ? "text-[#5DBE81]" : apy < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]"}`}>
                      {apy !== 0 ? (
                        <ApyValueTooltip apy={apy} roi={roi} daysToExpiry={getDaysToExpiry(m.expiryDate)}>
                          {`${apy > 0 ? "+" : ""}${formatPercent(apy)}`}
                        </ApyValueTooltip>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-[#FFFFFF]">{profit !== 0 ? formatProfitDisplay(profit, allArbs) : "—"}</td>
                    <td className="px-4 py-3 text-xs"><CompactStrategyDisplay strategy={strategy} /></td>
                    <td className="px-4 py-3 text-right text-xs text-[#8A9BA8]">{formatRelativeTime(scannedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// PERF-P0: memoized export — skip re-render when props are shallow-equal
export const OverviewPanel = React.memo(OverviewPanelInner);
