"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { Link2, Unlink, Loader2, ArrowRight, Search, BadgeCheck } from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────

export interface UnmatchedKalshi {
  ticker: string;
  title: string;
  artist?: string;
  yesAsk: number;
  noAsk: number;
}

export interface UnmatchedPolymarket {
  conditionId: string;
  marketId?: string;
  title: string;
  yesPrice: number;
  noPrice: number;
}

export interface ActiveMatch {
  id: string;
  kalshiTicker: string;
  kalshiTitle: string;
  pmConditionId: string;
  pmTitle: string;
}

interface KalshiMarketLite {
  ticker: string;
  title: string;
  yesAsk: number;
  noAsk: number;
  eventTicker: string | null;
  closeTime: string | null;
}

interface PolymarketLite {
  conditionId: string;
  slug: string;
  title: string;
  yesPrice: number;
  noPrice: number;
  endDate: string | null;
}

interface AllMarketsResponse {
  kalshi: KalshiMarketLite[];
  polymarket: PolymarketLite[];
  cached: boolean;
  source: string;
}

interface ManualMatchPanelProps {
  unmatchedKalshi: UnmatchedKalshi[];
  unmatchedPolymarket: UnmatchedPolymarket[];
  activeMatches: ActiveMatch[];
  kalshiUrl?: string;
  polymarketUrl?: string;
  onPair: (kalshiTicker: string, pmConditionId: string, kalshiTitle: string, pmTitle: string) => void;
  onUnpair: (matchId: string) => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// ─── Component ─────────────────────────────────────────────────────────

export default function ManualMatchPanel({
  unmatchedKalshi,
  unmatchedPolymarket,
  activeMatches,
  kalshiUrl,
  polymarketUrl,
  onPair,
  onUnpair,
}: ManualMatchPanelProps) {
  const [selectedKalshi, setSelectedKalshi] = useState<string | null>(null);
  const [selectedPm, setSelectedPm] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);

  // All-markets browse mode
  const [browseMode, setBrowseMode] = useState(true);
  const [allMarkets, setAllMarkets] = useState<AllMarketsResponse | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const [kalshiSearch, setKalshiSearch] = useState("");
  const [pmSearch, setPmSearch] = useState("");

  // Track which items are already matched (to grey them out)
  const matchedKalshiTickers = useMemo(() => {
    const s = new Set<string>();
    activeMatches.forEach(m => s.add(m.kalshiTicker));
    return s;
  }, [activeMatches]);

  const matchedPmIds = useMemo(() => {
    const s = new Set<string>();
    activeMatches.forEach(m => s.add(m.pmConditionId));
    return s;
  }, [activeMatches]);

  // ── Browse mode: fetch event-scoped markets from /api/all-markets ──
  const loadAllMarkets = useCallback(async () => {
    setLoadingAll(true);
    try {
      // Pass the Kalshi + Polymarket URLs to scope results to the linked events
      const params = new URLSearchParams();
      if (kalshiUrl) params.set('kalshiUrl', kalshiUrl);
      if (polymarketUrl) params.set('pmUrl', polymarketUrl);

      const res = await fetch(`/api/all-markets?${params.toString()}`, {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (res.ok) {
        const data = await res.json() as AllMarketsResponse;
        setAllMarkets(data);
      }
    } catch { /* ignore */ }
    setLoadingAll(false);
  }, [kalshiUrl, polymarketUrl]);

  useEffect(() => {
    if (browseMode && !allMarkets && !loadingAll) {
      loadAllMarkets();
    }
  }, [browseMode, allMarkets, loadingAll, loadAllMarkets]);

  // ── Build display lists ──
  // In browse mode: use all-markets data (merged with scan unmatched for completeness)
  // In scan mode: use only the scan result unmatched markets
  const kalshiList = useMemo(() => {
    if (!browseMode || !allMarkets) {
      return unmatchedKalshi.map(k => ({
        ticker: k.ticker,
        title: k.title,
        yesAsk: k.yesAsk,
        noAsk: k.noAsk,
        closeTime: null,
        isSuggested: false,
      }));
    }

    // Merge all-markets with scan unmatched (scan ones get priority/suggested badge)
    const scanTickers = new Set(unmatchedKalshi.map(k => k.ticker));
    const merged = new Map<string, any>();

    // Add all-markets first
    for (const k of allMarkets.kalshi) {
      merged.set(k.ticker, {
        ticker: k.ticker,
        title: k.title,
        yesAsk: k.yesAsk,
        noAsk: k.noAsk,
        closeTime: k.closeTime,
        isSuggested: false,
      });
    }

    // Overlay scan unmatched as suggested
    for (const k of unmatchedKalshi) {
      const existing = merged.get(k.ticker);
      if (existing) {
        existing.isSuggested = true;
        existing.yesAsk = k.yesAsk || existing.yesAsk;
        existing.noAsk = k.noAsk || existing.noAsk;
      } else {
        merged.set(k.ticker, {
          ticker: k.ticker,
          title: k.title,
          yesAsk: k.yesAsk,
          noAsk: k.noAsk,
          closeTime: null,
          isSuggested: true,
        });
      }
    }

    return Array.from(merged.values());
  }, [browseMode, allMarkets, unmatchedKalshi]);

  const pmList = useMemo(() => {
    if (!browseMode || !allMarkets) {
      return unmatchedPolymarket.map(p => ({
        conditionId: p.conditionId,
        title: p.title,
        yesPrice: p.yesPrice,
        noPrice: p.noPrice,
        endDate: null,
        isSuggested: false,
      }));
    }

    const scanIds = new Set(unmatchedPolymarket.map(p => p.conditionId));
    const merged = new Map<string, any>();

    for (const p of allMarkets.polymarket) {
      merged.set(p.conditionId, {
        conditionId: p.conditionId,
        title: p.title,
        yesPrice: p.yesPrice,
        noPrice: p.noPrice,
        endDate: p.endDate,
        isSuggested: false,
      });
    }

    for (const p of unmatchedPolymarket) {
      const existing = merged.get(p.conditionId);
      if (existing) {
        existing.isSuggested = true;
        existing.yesPrice = p.yesPrice || existing.yesPrice;
        existing.noPrice = p.noPrice || existing.noPrice;
      } else {
        merged.set(p.conditionId, {
          conditionId: p.conditionId,
          title: p.title,
          yesPrice: p.yesPrice,
          noPrice: p.noPrice,
          endDate: null,
          isSuggested: true,
        });
      }
    }

    return Array.from(merged.values());
  }, [browseMode, allMarkets, unmatchedPolymarket]);

  // ── Filtered + sorted lists ──
  const filteredKalshi = useMemo(() => {
    let list = kalshiList;
    if (kalshiSearch.trim()) {
      const q = kalshiSearch.toLowerCase();
      list = list.filter(k =>
        k.title?.toLowerCase().includes(q) ||
        k.ticker?.toLowerCase().includes(q)
      );
    }
    // Suggested first, then alphabetical
    return [...list].sort((a, b) => {
      if (a.isSuggested !== b.isSuggested) return a.isSuggested ? -1 : 1;
      return (a.title || '').localeCompare(b.title || '');
    });
  }, [kalshiList, kalshiSearch]);

  const filteredPm = useMemo(() => {
    let list = pmList;
    if (pmSearch.trim()) {
      const q = pmSearch.toLowerCase();
      list = list.filter(p =>
        p.title?.toLowerCase().includes(q) ||
        p.conditionId?.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      if (a.isSuggested !== b.isSuggested) return a.isSuggested ? -1 : 1;
      return (a.title || '').localeCompare(b.title || '');
    });
  }, [pmList, pmSearch]);

  const canPair = selectedKalshi && selectedPm;

  const handlePair = () => {
    if (!canPair) return;
    const k = kalshiList.find(k => k.ticker === selectedKalshi);
    const p = pmList.find(p => p.conditionId === selectedPm);
    if (!k || !p) return;
    setPairing(true);
    onPair(k.ticker, p.conditionId, k.title || k.ticker, p.title);
    setSelectedKalshi(null);
    setSelectedPm(null);
    setTimeout(() => setPairing(false), 800);
  };

  return (
    <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#182533]">
        <Link2 className="w-4 h-4 text-[#5DBE81]" />
        <h3 className="text-sm font-semibold text-[#FFFFFF]">Manual Market Matching</h3>
        <span className="text-[10px] text-[#8A9BA8]">
          ({kalshiList.length} Kalshi · {pmList.length} Polymarket)
        </span>
        <div className="flex-1" />
        {/* Browse toggle */}
        <button
          onClick={() => setBrowseMode(b => !b)}
          className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
            browseMode
              ? "bg-[#5DBE81]/20 text-[#5DBE81] border border-[#5DBE81]/30"
              : "text-[#8A9BA8] hover:text-[#FFFFFF] border border-[#182533]"
          }`}
          title="Toggle between scan-only and all-platforms browse mode"
        >
          {browseMode ? "Showing Event Markets" : "Showing Scan Results"}
        </button>
        {browseMode && (
          <button
            onClick={loadAllMarkets}
            disabled={loadingAll}
            className="px-2 py-1 rounded-md text-[10px] text-[#8A9BA8] hover:text-[#FFFFFF] transition-colors"
          >
            {loadingAll ? "Loading…" : "Refresh"}
          </button>
        )}
      </div>

      {/* Active matches */}
      {activeMatches.length > 0 && (
        <div className="px-4 py-3 border-b border-[#182533] bg-[#0E1621]">
          <div className="text-[10px] text-[#8A9BA8] uppercase tracking-wider mb-2">Matched Pairs ({activeMatches.length})</div>
          <div className="space-y-1.5">
            {activeMatches.map(mm => (
              <div key={mm.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#17212B] border border-[#5DBE81]/20">
                <div className="flex-1 grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-xs">
                  <div className="min-w-0 flex items-center gap-1">
                    <img src="/kalshi-icon.png" alt="Kalshi" className="w-3 h-3 rounded-sm shrink-0" />
                    <span className="text-[#FFFFFF] truncate" title={mm.kalshiTitle}>{mm.kalshiTitle}</span>
                  </div>
                  <ArrowRight className="w-3 h-3 text-[#5E6875] shrink-0" />
                  <div className="min-w-0 flex items-center gap-1">
                    <img src="/polymarket-icon.png" alt="Polymarket" className="w-3 h-3 rounded-sm shrink-0" />
                    <span className="text-[#FFFFFF] truncate" title={mm.pmTitle}>{mm.pmTitle}</span>
                  </div>
                </div>
                <button
                  onClick={() => onUnpair(mm.id)}
                  className="p-1.5 rounded-md bg-[#ef4444]/10 hover:bg-[#ef4444]/20 text-[#ef4444] transition-colors shrink-0"
                  title="Unlink this pair"
                >
                  <Unlink className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Two-list pairing interface */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-0">
        {/* Kalshi list (left) */}
        <div className="border-r border-[#182533]">
          <div className="px-4 py-2.5 border-b border-[#182533]">
            <div className="flex items-center gap-1.5 mb-2">
              <img src="/kalshi-icon.png" alt="Kalshi" className="w-3.5 h-3.5 rounded-sm" />
              <span className="text-[10px] uppercase tracking-wider text-[#8A9BA8]">Kalshi Markets</span>
              <span className="text-[9px] text-[#8A9BA8]">({filteredKalshi.length})</span>
            </div>
            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[#8A9BA8]" />
              <input
                type="text"
                value={kalshiSearch}
                onChange={e => setKalshiSearch(e.target.value)}
                placeholder="Search Kalshi markets…"
                className="w-full pl-7 pr-2 py-1 rounded-md bg-[#0E1621] border border-[#182533] text-[11px] text-[#FFFFFF] placeholder:text-[#8A9BA8] focus:outline-none focus:border-[#5DBE81]"
              />
            </div>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {filteredKalshi.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[#8A9BA8]">
                {loadingAll ? "Loading all markets…" : "No Kalshi markets found"}
              </div>
            ) : (
              filteredKalshi.map(k => {
                const isMatched = matchedKalshiTickers.has(k.ticker);
                const isSelected = selectedKalshi === k.ticker;
                return (
                  <button
                    key={k.ticker}
                    onClick={() => !isMatched && setSelectedKalshi(isSelected ? null : k.ticker)}
                    disabled={isMatched}
                    className={`w-full text-left px-4 py-2.5 border-b border-[#182533] transition-colors ${
                      isSelected
                        ? "bg-[#5DBE81]/15 border-l-2 border-l-[#5DBE81]"
                        : isMatched
                        ? "opacity-30 cursor-not-allowed bg-[#0E1621]"
                        : "hover:bg-[#0E1621] border-l-2 border-l-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      {k.isSuggested && !isMatched && (
                        <BadgeCheck className="w-3 h-3 text-[#5DBE81] shrink-0" title="From current scan" />
                      )}
                      <div className="text-xs text-[#FFFFFF] truncate" title={k.title}>{k.title}</div>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[9px] text-[#8A9BA8] font-mono truncate">{k.ticker}</span>
                      {k.yesAsk > 0 && <span className="text-[9px] text-[#5DBE81]">Y {fmtPct(k.yesAsk)}</span>}
                      {k.noAsk > 0 && <span className="text-[9px] text-[#ef4444]">N {fmtPct(k.noAsk)}</span>}
                    </div>
                    {isMatched && <span className="text-[8px] text-[#8A9BA8]">✓ matched</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Pair action (center) */}
        <div className="flex md:flex-col items-center justify-center px-3 py-4 bg-[#0E1621] border-t md:border-t-0 border-[#182533]">
          <button
            onClick={handlePair}
            disabled={!canPair || pairing}
            className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg bg-[#5DBE81]/10 hover:bg-[#5DBE81]/20 border border-[#5DBE81]/30 text-[#5DBE81] transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            title={canPair ? "Link selected pair" : "Select one from each side"}
          >
            {pairing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Link2 className="w-4 h-4" />
            )}
            <span className="text-[9px] font-medium">Link</span>
          </button>
        </div>

        {/* Polymarket list (right) */}
        <div className="border-l border-[#182533] border-t md:border-t-0 border-[#182533]">
          <div className="px-4 py-2.5 border-b border-[#182533]">
            <div className="flex items-center gap-1.5 mb-2">
              <img src="/polymarket-icon.png" alt="Polymarket" className="w-3.5 h-3.5 rounded-sm" />
              <span className="text-[10px] uppercase tracking-wider text-[#8A9BA8]">Polymarket Markets</span>
              <span className="text-[9px] text-[#8A9BA8]">({filteredPm.length})</span>
            </div>
            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[#8A9BA8]" />
              <input
                type="text"
                value={pmSearch}
                onChange={e => setPmSearch(e.target.value)}
                placeholder="Search Polymarket markets…"
                className="w-full pl-7 pr-2 py-1 rounded-md bg-[#0E1621] border border-[#182533] text-[11px] text-[#FFFFFF] placeholder:text-[#8A9BA8] focus:outline-none focus:border-[#a855f7]"
              />
            </div>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {filteredPm.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[#8A9BA8]">
                {loadingAll ? "Loading all markets…" : "No Polymarket markets found"}
              </div>
            ) : (
              filteredPm.map(p => {
                const isMatched = matchedPmIds.has(p.conditionId);
                const isSelected = selectedPm === p.conditionId;
                return (
                  <button
                    key={p.conditionId}
                    onClick={() => !isMatched && setSelectedPm(isSelected ? null : p.conditionId)}
                    disabled={isMatched}
                    className={`w-full text-left px-4 py-2.5 border-b border-[#182533] transition-colors ${
                      isSelected
                        ? "bg-[#a855f7]/15 border-r-2 border-r-[#a855f7]"
                        : isMatched
                        ? "opacity-30 cursor-not-allowed bg-[#0E1621]"
                        : "hover:bg-[#0E1621] border-r-2 border-r-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      {p.isSuggested && !isMatched && (
                        <BadgeCheck className="w-3 h-3 text-[#a855f7] shrink-0" title="From current scan" />
                      )}
                      <div className="text-xs text-[#FFFFFF] truncate" title={p.title}>{p.title}</div>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[9px] text-[#8A9BA8] font-mono truncate">{p.conditionId.slice(0, 16)}…</span>
                      {p.yesPrice > 0 && <span className="text-[9px] text-[#5DBE81]">Y {fmtPct(p.yesPrice)}</span>}
                      {p.noPrice > 0 && <span className="text-[9px] text-[#ef4444]">N {fmtPct(p.noPrice)}</span>}
                    </div>
                    {isMatched && <span className="text-[8px] text-[#8A9BA8]">✓ matched</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Selection hint */}
      <div className="px-4 py-2 border-t border-[#182533] bg-[#0E1621]">
        <div className="text-[10px] text-[#8A9BA8] text-center">
          {canPair
            ? "Click Link to pair selected markets"
            : selectedKalshi
            ? "Now select a Polymarket market →"
            : selectedPm
            ? "← Now select a Kalshi market"
            : browseMode
            ? "Browse event markets · Select one from each side to pair"
            : "Select one market from each side to pair them"}
        </div>
      </div>
    </div>
  );
}