// MarketSidebar.tsx — left nav + saved markets sidebar (PERF-002 split from page.tsx).
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Activity, FileText, Globe, Layers, LayoutDashboard, Loader2, Receipt, RefreshCw, Scan, Star, X, Zap } from "lucide-react";
import { computeApy } from "@/lib/matcher";
import { SavedMarket, formatPercent } from "@/app/lib/page-shared";
import { tickFreshness, freshnessColor, hotPairIdSet } from "@/lib/watcher-status";

/** Format a "time ago" string from an ISO timestamp for the sidebar hover tooltip. */
function formatTimeAgo(scannedAt: string | null | undefined): string {
  if (!scannedAt) return "Never";
  const diffSec = Math.round((Date.now() - new Date(scannedAt).getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

/* ── Nav Button (collapsible sidebar icon button) ── */
function NavButton({ icon, label, active, onClick, collapsed }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void; collapsed: boolean }) {
  if (collapsed) {
    return (
      <button
        onClick={onClick}
        className={`w-full flex items-center justify-center p-3 rounded-lg transition-colors ${
          active
            ? "bg-[#5DBE81]/10 text-[#5DBE81] ring-1 ring-[#5DBE81]/30"
            : "text-[#8A9BA8] hover:bg-[#182533] hover:text-[#FFFFFF]"
        }`}
        title={label}
      >
        {icon}
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
        active
          ? "bg-[#5DBE81]/10 text-[#5DBE81]"
          : "bg-[#182533] text-[#8A9BA8] hover:bg-[#232E3C] hover:text-[#FFFFFF]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/* ── Market Sidebar ── */
function MarketSidebarInner({
  markets,
  activeId,
  viewMode,
  sidebarOpen,
  onToggleSidebar,
  onSelectMarket,
  onDeleteMarket,
  sort,
  sortDir,
  onToggleSort,
  timeUntilExpiry,
  expiryFilter,
  onSetExpiryFilter,
  showExpired,
  onToggleShowExpired,
  showArbOnly,
  onToggleShowArbOnly,
  onScanAll,
  scanningAll,
  scanProgress,
  scanAllError,
  onGoOverview,
  onGoScan,
  onGoMarketFinder,
  onGoLogs,
  onGoDashboard,
  onGoTrades,
  favoriteIds,
  onToggleFavorite,
  sidebarFavoritesOnly,
  onToggleSidebarFavorites,
  mobileMenuOpen,
  onCloseMobileMenu,
}: {
  markets: SavedMarket[];
  activeId: string | null;
  viewMode: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onSelectMarket: (m: SavedMarket) => void;
  onDeleteMarket: (id: string) => void;
  sort: "name" | "roi" | "expiry" | "apy" | "scanned";
  sortDir: "asc" | "desc";
  onToggleSort: (field: "name" | "roi" | "expiry" | "apy" | "scanned") => void;
  timeUntilExpiry: (iso?: string | null) => string;
  expiryFilter: "all" | "lte7" | "lte14" | "lte30";
  onSetExpiryFilter: (f: "all" | "lte7" | "lte14" | "lte30") => void;
  showExpired: boolean;
  onToggleShowExpired: () => void;
  showArbOnly: boolean;
  onToggleShowArbOnly: () => void;
  onScanAll: (markets: SavedMarket[]) => void;
  scanningAll: boolean;
  scanProgress: { current: number; total: number };
  scanAllError: string;
  onGoOverview: () => void;
  onGoScan: () => void;
  onGoMarketFinder: () => void;
  onGoLogs: () => void;
  onGoDashboard: () => void;
  onGoTrades: () => void;
  favoriteIds: Set<string>;
  onToggleFavorite: (id: string) => void;
  sidebarFavoritesOnly: boolean;
  onToggleSidebarFavorites: () => void;
  mobileMenuOpen: boolean;
  onCloseMobileMenu: () => void;
}) {
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [sidebarCategory, setSidebarCategory] = useState<string>("all");

  // UI-012: derive category options from categories actually present in saved
  // markets. The static CATEGORIES list ('economics', 'technology', …) didn't
  // match stored values ('Finances', 'Tech', …), so several options matched
  // nothing and some stored categories were unselectable.
  const availableCategories = Array.from(
    new Set(markets.map((m) => m.category?.trim()).filter((c): c is string => !!c))
  ).sort((a, b) => a.localeCompare(b));

  // WS-106: HOT tier badge — poll lightweight tier-state endpoint every 60s.
  const [hotIds, setHotIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/watcher/tiers", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setHotIds(hotPairIdSet(data.tierState));
      } catch { /* watcher down — no badges, no noise */ }
    };
    poll();
    const id = setInterval(poll, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Filter + sort (memoized — PERF-P0: avoid re-running over 400+ markets on every parent render)
  const filtered = useMemo(() => markets.filter(m => {
    // UI-013: expired = past expiryDate OR PM reports the market closed
    // (PM endDate is often far future even after resolution).
    const isExpired =
      (m.expiryDate ? new Date(m.expiryDate).getTime() < Date.now() : false) ||
      Boolean(m.lastScanResult?.pmClosed);
    if (!showExpired && isExpired) return false;

    if (expiryFilter !== "all") {
      if (!m.expiryDate) return false;
      const days = (new Date(m.expiryDate).getTime() - Date.now()) / 86400000;
      if (expiryFilter === "lte7" && days > 7) return false;
      if (expiryFilter === "lte14" && days > 14) return false;
      if (expiryFilter === "lte30" && days > 30) return false;
    }
    if (sidebarCategory !== "all" && m.category?.toLowerCase() !== sidebarCategory.toLowerCase()) return false;
    if (sidebarSearch && !m.eventTitle.toLowerCase().includes(sidebarSearch.toLowerCase())) return false;
    if (sidebarFavoritesOnly && !favoriteIds.has(m.id)) return false;
    if (showArbOnly) {
      const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
      if (roi <= 0) return false;
    }
    return true;
  }).sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sort === "name") return mul * a.eventTitle.localeCompare(b.eventTitle);
    if (sort === "expiry") {
      const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
      const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
      return mul * (ea - eb);
    }
    if (sort === "roi") {
      const ra = a.liveResult?.bestRoiPct ?? a.lastScanResult?.bestRoiPct ?? 0;
      const rb = b.liveResult?.bestRoiPct ?? b.lastScanResult?.bestRoiPct ?? 0;
      return mul * (rb - ra);
    }
    if (sort === "apy") {
      const aa = computeApy(a.liveResult?.bestRoiPct ?? a.lastScanResult?.bestRoiPct ?? 0, a.expiryDate);
      const ab = computeApy(b.liveResult?.bestRoiPct ?? b.lastScanResult?.bestRoiPct ?? 0, b.expiryDate);
      return mul * (ab - aa);
    }
    if (sort === "scanned") {
      // desc = stalest first (longest since last scan), asc = most recent first
      const sa = a.lastScanResult?.scannedAt ? new Date(a.lastScanResult.scannedAt).getTime() : 0;
      const sb = b.lastScanResult?.scannedAt ? new Date(b.lastScanResult.scannedAt).getTime() : 0;
      return mul * (sa - sb);
    }
    return 0;
  }), [markets, showExpired, expiryFilter, sidebarCategory, sidebarSearch, sidebarFavoritesOnly, favoriteIds, showArbOnly, sort, sortDir]);

  return (
    <>
      {/* Mobile overlay backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onCloseMobileMenu}
        />
      )}
      <aside
        className={`${
          sidebarOpen
            ? "w-[380px]"
            : "w-[64px]"
        } shrink-0 border-r border-[#182533] bg-[#17212B] transition-all duration-200 md:block ${
          mobileMenuOpen
            ? "fixed inset-y-0 left-0 z-50 w-[380px] max-w-[85vw] md:relative md:w-auto md:z-auto md:inset-auto"
            : "hidden md:block md:!w-auto"
        } ${!sidebarOpen ? "overflow-visible" : "overflow-hidden"}`}
      >
        <div className="px-3 py-4 space-y-4 h-full flex flex-col">
          {/* Close button for mobile */}
          <button
            onClick={onCloseMobileMenu}
            className="absolute top-3 right-3 p-1 rounded-lg hover:bg-[#182533] md:hidden z-10"
          >
            <X className="w-4 h-4" />
          </button>

          {/* ── Navigation ── */}
          <div className="space-y-1 sticky top-0 z-10 bg-[#17212B] pb-2">
            <NavButton icon={<LayoutDashboard className="w-5 h-5 shrink-0" />} label="Dashboard" active={viewMode === "dashboard"} onClick={onGoDashboard} collapsed={!sidebarOpen} />
            <NavButton icon={<Layers className="w-5 h-5 shrink-0" />} label="Markets" active={viewMode === "overview"} onClick={onGoOverview} collapsed={!sidebarOpen} />
            <NavButton icon={<Scan className="w-5 h-5 shrink-0" />} label="Scan" active={viewMode === "scan"} onClick={onGoScan} collapsed={!sidebarOpen} />
            <NavButton icon={<Globe className="w-5 h-5 shrink-0" />} label="MarketFinder" active={viewMode === "marketfinder"} onClick={onGoMarketFinder} collapsed={!sidebarOpen} />
            <NavButton icon={<Activity className="w-5 h-5 shrink-0" />} label="Live WS" active={viewMode === "live"} onClick={() => window.location.href = '/?view=live'} collapsed={!sidebarOpen} />
            <NavButton icon={<FileText className="w-5 h-5 shrink-0" />} label="Logs" active={viewMode === "logs"} onClick={onGoLogs} collapsed={!sidebarOpen} />
            <NavButton icon={<Receipt className="w-5 h-5 shrink-0" />} label="Trades" active={viewMode === "trades"} onClick={onGoTrades} collapsed={!sidebarOpen} />
          </div>

          {sidebarOpen && (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-xs font-semibold text-[#8A9BA8] tracking-wide uppercase">Saved Markets ({filtered.length}{filtered.length !== markets.length ? `/${markets.length}` : ""})</h2>
                  <button
                    onClick={onToggleSidebarFavorites}
                    className={`p-0.5 rounded transition-colors ${
                      sidebarFavoritesOnly ? "text-[#facc15]" : "text-[#8A9BA8] hover:text-[#FFFFFF]"
                    }`}
                    title={sidebarFavoritesOnly ? "Show all markets" : "Show favorites only"}
                  >
                    <Star className="w-3 h-3" fill={sidebarFavoritesOnly ? "currentColor" : "none"} />
                  </button>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => onToggleSort("apy")}
                    className={`px-1.5 py-1 rounded-md text-[10px] font-semibold transition-colors ${
                      sort === "apy" ? "bg-[#5DBE81]/15 text-[#5DBE81] ring-1 ring-[#5DBE81]/30" : "text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-[#182533]"
                    }`}
                    title="Sort by APY"
                  >
                    APY{sort === "apy" && (sortDir === "asc" ? " ↑" : " ↓")}
                  </button>
                  <button
                    onClick={() => onToggleSort("roi")}
                    className={`px-1.5 py-1 rounded-md text-[10px] font-semibold transition-colors ${
                      sort === "roi" ? "bg-[#5DBE81]/15 text-[#5DBE81] ring-1 ring-[#5DBE81]/30" : "text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-[#182533]"
                    }`}
                    title="Sort by ROI"
                  >
                    ROI{sort === "roi" && (sortDir === "asc" ? " ↑" : " ↓")}
                  </button>
                  <button
                    onClick={() => onToggleSort("name")}
                    className={`px-1.5 py-1 rounded-md text-[10px] font-semibold transition-colors ${
                      sort === "name" ? "bg-[#5DBE81]/15 text-[#5DBE81] ring-1 ring-[#5DBE81]/30" : "text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-[#182533]"
                    }`}
                    title="Sort by Name"
                  >
                    A-Z{sort === "name" && (sortDir === "asc" ? " ↑" : " ↓")}
                  </button>
                  <button
                    onClick={() => onToggleSort("scanned")}
                    className={`px-1.5 py-1 rounded-md text-[10px] font-semibold transition-colors ${
                      sort === "scanned" ? "bg-[#5DBE81]/15 text-[#5DBE81] ring-1 ring-[#5DBE81]/30" : "text-[#8A9BA8] hover:text-[#FFFFFF] hover:bg-[#182533]"
                    }`}
                    title="Sort by last scan time (click to toggle asc/desc)"
                  >
                    Scanned{sort === "scanned" && (sortDir === "asc" ? " ↑" : " ↓")}
                  </button>
                  <div className="w-px h-4 bg-[#232E3C] mx-0.5" />
                  <button onClick={() => onScanAll(filtered)} disabled={scanningAll} className="p-1.5 rounded-md hover:bg-[#182533] text-[#8A9BA8] hover:text-[#5DBE81] transition-colors disabled:opacity-50" title="Scan filtered markets">
                    {scanningAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {scanningAll && scanProgress.total > 0 && (
                <div className="flex items-center gap-2 text-[10px] text-[#8A9BA8]">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Scanning {scanProgress.current}/{scanProgress.total}...
                </div>
              )}
              {scanAllError && <div className="text-xs text-[#ef4444]">{scanAllError}</div>}

              {/* Filters */}
              <div className="space-y-2">
                <input
                  type="text"
                  value={sidebarSearch}
                  onChange={(e) => setSidebarSearch(e.target.value)}
                  placeholder="Filter by name..."
                  className="w-full px-2 py-1.5 rounded-lg border border-[#232E3C] bg-[#0E1621] border border-[#232E3C] text-xs text-[#FFFFFF] placeholder-[#232E3C] focus:outline-none focus:border-[#5DBE81]"
                />
                <div className="flex items-center gap-1.5 flex-wrap">
                  <select
                    value={expiryFilter}
                    onChange={(e) => onSetExpiryFilter(e.target.value as any)}
                    className="px-2.5 py-1.5 rounded-lg border border-[#232E3C] bg-[#0E1621] text-[11px] text-[#8A9BA8] focus:outline-none focus:border-[#5DBE81]/50 cursor-pointer hover:text-[#FFFFFF] transition-colors"
                  >
                    <option value="all">All expiries</option>
                    <option value="lte7">≤ 7 days</option>
                    <option value="lte14">≤ 14 days</option>
                    <option value="lte30">≤ 30 days</option>
                  </select>
                  <select
                    value={sidebarCategory}
                    onChange={(e) => setSidebarCategory(e.target.value)}
                    className="px-2.5 py-1.5 rounded-lg border border-[#232E3C] bg-[#0E1621] text-[11px] text-[#8A9BA8] focus:outline-none focus:border-[#5DBE81]/50 cursor-pointer hover:text-[#FFFFFF] transition-colors"
                  >
                    <option value="all">All categories</option>
                    {availableCategories.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <button
                    onClick={onToggleShowExpired}
                    className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
                      showExpired
                        ? "bg-[#5DBE81]/15 text-[#5DBE81] border-[#5DBE81]/30"
                        : "bg-[#0E1621] text-[#8A9BA8] border-[#232E3C] hover:text-[#FFFFFF] hover:border-[#3A4858]"
                    }`}
                    title={showExpired ? "Hide expired markets" : "Show expired markets"}
                  >
                    Expired
                  </button>
                  <button
                    onClick={onToggleShowArbOnly}
                    className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
                      showArbOnly
                        ? "bg-[#5DBE81]/15 text-[#5DBE81] border-[#5DBE81]/30"
                        : "bg-[#0E1621] text-[#8A9BA8] border-[#232E3C] hover:text-[#FFFFFF] hover:border-[#3A4858]"
                    }`}
                    title={showArbOnly ? "Show all markets" : "Show only arbitrage opportunities"}
                  >
                    Arb Only
                  </button>
                </div>
              </div>

              {/* Market list */}
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {filtered.map((m) => {
                  const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
                  const apy = computeApy(roi, m.expiryDate);
                  const isActive = activeId === m.id;
                  return (
                    <div
                      key={m.id}
                      onClick={() => onSelectMarket(m)}
                      // PERF-P2: browser-native virtualization — off-screen rows
                      // are skipped during layout/paint (470+ markets).
                      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 40px" }}
                      className={`group flex items-center gap-2 pl-1 pr-2 py-2 rounded-lg cursor-pointer transition-colors ${
                        isActive ? "bg-[#5DBE81]/10 ring-1 ring-[#5DBE81]/30" : "hover:bg-[#182533]"
                      }`}
                      title={`Latest scanned: ${formatTimeAgo(m.liveResult?.scannedAt ?? m.lastScanResult?.scannedAt)}`}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFavorite(m.id);
                        }}
                        className={`shrink-0 p-0.5 rounded transition-colors ${
                          favoriteIds.has(m.id)
                            ? "text-[#facc15]"
                            : "text-[#8A9BA8] group-hover:text-[#FFFFFF]"
                        }`}
                        title={favoriteIds.has(m.id) ? "Remove favorite" : "Add favorite"}
                      >
                        <Star className="w-3 h-3" fill={favoriteIds.has(m.id) ? "currentColor" : "none"} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1 min-w-0">
                          <div className="text-xs font-medium text-[#FFFFFF] truncate">{m.eventTitle}</div>
                          {hotIds.has(m.id) && (
                            <span
                              className="shrink-0 inline-flex items-center gap-0.5 text-[8px] font-bold px-1 py-px rounded-full bg-[#f97316]/15 text-[#f97316] ring-1 ring-[#f97316]/30 uppercase"
                              title="HOT tier — live WebSocket-watched"
                            >
                              <Zap className="w-2 h-2" fill="currentColor" />HOT
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {m.category && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#182533] text-[#8A9BA8]">{m.category}</span>
                          )}
                          <span className="text-[9px] text-[#8A9BA8]">{timeUntilExpiry(m.expiryDate)}</span>
                          {(() => {
                            // WS-106: last-tick freshness — prefer live WS result, fall back to poller scan
                            const f = tickFreshness(m.liveResult?.scannedAt ?? m.lastScanResult?.scannedAt ?? null);
                            if (f.level === 'never') return null;
                            return (
                              <span className={`text-[9px] inline-flex items-center gap-0.5 ${freshnessColor(f.level)}`} title={`Last price update: ${f.label}`}>
                                <span className={`w-1 h-1 rounded-full ${f.level === 'live' ? 'bg-[#5DBE81] animate-pulse' : f.level === 'recent' ? 'bg-[#8A9BA8]' : f.level === 'stale' ? 'bg-[#facc15]' : 'bg-[#ef4444]'}`} />
                                {f.label}
                              </span>
                            );
                          })()}
                        </div>
                      </div>
                      <div className="flex items-center shrink-0">
                        {roi !== 0 && (
                          <span className={`text-xs font-bold ${roi > 0 ? "text-[#5DBE81]" : "text-[#ef4444]"}`}>
                            {roi > 0 ? "+" : ""}{formatPercent(roi)}
                          </span>
                        )}
                        {apy > 0 && (
                          <span className="text-[10px] text-[#8A9BA8] ml-1">({formatPercent(apy)})</span>
                        )}
                      </div>
                    </div>
                  );
                })}
                {filtered.length === 0 && markets.length > 0 && (
                  <div className="text-xs text-[#8A9BA8] text-center py-4">No markets match filters.</div>
                )}
                {markets.length === 0 && (
                  <div className="text-xs text-[#8A9BA8] text-center py-4">No saved markets yet.</div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

// PERF-P0: memoized export — skip re-render when props are shallow-equal
export const MarketSidebar = React.memo(MarketSidebarInner);
