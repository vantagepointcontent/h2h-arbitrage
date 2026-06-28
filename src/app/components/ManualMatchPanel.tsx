"use client";

import { useState, useMemo } from "react";
import { Link2, Unlink, Check, Loader2, ArrowRight } from "lucide-react";

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

export function ManualMatchPanel({
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

  const canPair = selectedKalshi && selectedPm;

  const handlePair = () => {
    if (!canPair) return;
    const k = unmatchedKalshi.find(k => k.ticker === selectedKalshi);
    const p = unmatchedPolymarket.find(p => p.conditionId === selectedPm);
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
        <span className="text-[10px] text-[#5E6875]">
          ({unmatchedKalshi.length} Kalshi · {unmatchedPolymarket.length} Polymarket unmatched)
        </span>
      </div>

      {/* Active matches */}
      {activeMatches.length > 0 && (
        <div className="px-4 py-3 border-b border-[#182533] bg-[#0E1621]">
          <div className="text-[10px] text-[#5E6875] uppercase tracking-wider mb-2">Matched Pairs ({activeMatches.length})</div>
          <div className="space-y-1.5">
            {activeMatches.map(mm => (
              <div key={mm.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#17212B] border border-[#5DBE81]/20">
                <div className="flex-1 grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-xs">
                  <div className="min-w-0">
                    <span className="text-[10px] text-[#5DBE81]">K</span>
                    <span className="text-[#FFFFFF] truncate ml-1" title={mm.kalshiTitle}>{mm.kalshiTitle}</span>
                  </div>
                  <ArrowRight className="w-3 h-3 text-[#5E6875] shrink-0" />
                  <div className="min-w-0">
                    <span className="text-[10px] text-[#a855f7]">PM</span>
                    <span className="text-[#FFFFFF] truncate ml-1" title={mm.pmTitle}>{mm.pmTitle}</span>
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
      <div className="grid grid-cols-[1fr_auto_1fr] gap-0">
        {/* Kalshi list (left) */}
        <div className="border-r border-[#182533]">
          <div className="px-4 py-2.5 border-b border-[#182533] flex items-center gap-1.5">
            <img src="/kalshi-icon.png" alt="" className="w-3.5 h-3.5 rounded-sm" />
            <span className="text-[10px] uppercase tracking-wider text-[#5E6875]">Kalshi Markets</span>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {unmatchedKalshi.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[#5E6875]">No unmatched Kalshi markets</div>
            ) : (
              unmatchedKalshi.map(k => {
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
                    <div className="text-xs text-[#FFFFFF] truncate" title={k.title}>{k.title}</div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[9px] text-[#5E6875] font-mono truncate">{k.ticker}</span>
                      <span className="text-[9px] text-[#5DBE81]">Y {fmtPct(k.yesAsk)}</span>
                      <span className="text-[9px] text-[#ef4444]">N {fmtPct(k.noAsk)}</span>
                    </div>
                    {isMatched && (
                      <span className="text-[8px] text-[#5E6875]">✓ matched</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Pair action (center) */}
        <div className="flex flex-col items-center justify-center px-3 py-4 bg-[#0E1621]">
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
        <div className="border-l border-[#182533]">
          <div className="px-4 py-2.5 border-b border-[#182533] flex items-center gap-1.5">
            <img src="/polymarket-icon.png" alt="" className="w-3.5 h-3.5 rounded-sm" />
            <span className="text-[10px] uppercase tracking-wider text-[#5E6875]">Polymarket Markets</span>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {unmatchedPolymarket.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[#5E6875]">No unmatched Polymarket markets</div>
            ) : (
              unmatchedPolymarket.map(p => {
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
                    <div className="text-xs text-[#FFFFFF] truncate" title={p.title}>{p.title}</div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[9px] text-[#5E6875] font-mono truncate">{p.conditionId.slice(0, 16)}…</span>
                      <span className="text-[9px] text-[#5DBE81]">Y {fmtPct(p.yesPrice)}</span>
                      <span className="text-[9px] text-[#ef4444]">N {fmtPct(p.noPrice)}</span>
                    </div>
                    {isMatched && (
                      <span className="text-[8px] text-[#5E6875]">✓ matched</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Selection hint */}
      <div className="px-4 py-2 border-t border-[#182533] bg-[#0E1621]">
        <div className="text-[10px] text-[#5E6875] text-center">
          {canPair
            ? "Click Link to pair selected markets"
            : selectedKalshi
            ? "Now select a Polymarket market →"
            : selectedPm
            ? "← Now select a Kalshi market"
            : "Select one market from each side to pair them"}
        </div>
      </div>
    </div>
  );
}