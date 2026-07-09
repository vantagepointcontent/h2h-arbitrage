"use client";

import { useMemo } from "react";
import { TrendingUp, Zap } from "lucide-react";
import { parseArbLegs, formatConciseStrategy, LegBreakdown } from "./ArbLegBreakdown";
import { computeApy } from "@/lib/matcher";

interface Outcome {
  artist: string;
  kalshi?: { ticker?: string; yesAsk: number; noAsk: number; yesAskDepth?: string; noAskDepth?: string } | null;
  polymarket?: { conditionId?: string; yesPrice: number; noPrice: number; askDepth?: number; noAskDepth?: number } | null;
  arbitrage: {
    strategy: string;
    expectedProfit: number;
    roiPct: number;
    apyPct?: number;
    kalshiStake?: number;
    pmStake?: number;
    maxCapital?: number;
    buyPlatform?: 'kalshi' | 'polymarket' | null;
    buyPrice?: number;
    sellPlatform?: 'kalshi' | 'polymarket' | null;
    sellPrice?: number;
    fees?: {
      kalshiFee: number;
      pmFee: number;
      kalshiFeeDetails: string;
      pmFeeDetails: string;
      worstCaseNetProfit: number;
    };
  };
}

interface Props {
  outcomes: Outcome[];
  formatCurrency: (n: number) => string;
  marketExpiryDate?: string | null;
}

/**
 * UI-16b: Arb Opportunities — always-visible section below the outcomes table.
 *
 * Shows ONLY positive-arb rows with full leg mapping (no expanding needed).
 * Each row shows strategy type badge, leg breakdown, ROI, profit, APY.
 * Distinct from the outcomes table which shows ALL outcomes (including non-arb).
 */
export function ArbOpportunitiesPanel({ outcomes, formatCurrency, marketExpiryDate }: Props) {
  const arbOpps = useMemo(() => {
    return outcomes
      .filter(o => o.arbitrage.expectedProfit > 0 && o.arbitrage.roiPct > 0)
      .sort((a, b) => b.arbitrage.roiPct - a.arbitrage.roiPct);
  }, [outcomes]);

  if (arbOpps.length === 0) {
    return (
      <div className="mt-4 rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#182533]">
          <Zap className="w-4 h-4 text-[#5DBE81]" />
          <h3 className="text-sm font-semibold text-[#FFFFFF]">Arb Opportunities</h3>
          <span className="text-[10px] text-[#8A9BA8]">(0)</span>
        </div>
        <div className="px-4 py-8 text-center text-xs text-[#8A9BA8]">
          No active arbitrage opportunities
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#182533]">
        <TrendingUp className="w-4 h-4 text-[#facc15]" />
        <h3 className="text-sm font-semibold text-[#FFFFFF]">Arb Opportunities</h3>
        <span className="text-[10px] text-[#8A9BA8]">({arbOpps.length})</span>
        <span className="text-[10px] text-[#5E6875] ml-auto">Sorted by ROI ↓</span>
      </div>

      {/* Arb rows */}
      <div className="divide-y divide-[#182533]">
        {arbOpps.map((o, idx) => {
          const breakdown = parseArbLegs(
            o.arbitrage.strategy,
            o.artist,
            o.kalshi?.yesAsk ?? null,
            o.kalshi?.noAsk ?? null,
            o.polymarket?.yesPrice ?? null,
            o.polymarket?.noPrice ?? null,
            o.arbitrage.kalshiStake ?? 0,
            o.arbitrage.pmStake ?? 0,
          );
          const concise = formatConciseStrategy(o.arbitrage.strategy);
          const isSamePlatform = o.arbitrage.strategy.startsWith("Same-platform");
          const badgeText = isSamePlatform ? "Same-Platform" : concise.isCross ? "Cross" : "Regular";
          const badgeColor = isSamePlatform
            ? "bg-[#a855f7]/15 text-[#a855f7] border-[#a855f7]/30"
            : concise.isCross
              ? "bg-[#ef4444]/15 text-[#ef4444] border-[#ef4444]/30"
              : "bg-[#5DBE81]/15 text-[#5DBE81] border-[#5DBE81]/30";

          const apy = o.arbitrage.apyPct ?? computeApy(o.arbitrage.roiPct, marketExpiryDate);

          return (
            <div key={`${idx}-${o.artist}`} className="px-4 py-3 hover:bg-[#0E1621] transition-colors">
              {/* Row 1: badge + concise strategy + ROI + profit + APY */}
              <div className="flex items-center gap-3 flex-wrap">
                <span className={`px-2 py-0.5 rounded text-[9px] font-medium border ${badgeColor}`}>
                  {badgeText}
                </span>
                <span className="text-xs text-[#FFFFFF] font-mono">{concise.text}</span>
                <div className="flex-1" />
                <span className="text-xs font-bold text-[#5DBE81]" title="ROI (net of fees)">
                  {o.arbitrage.roiPct.toFixed(2)}%
                </span>
                <span className="text-xs text-[#5DBE81]" title="Expected profit (net of fees)">
                  {formatCurrency(o.arbitrage.expectedProfit)}
                </span>
                {apy > 0 && (
                  <span className="text-[10px] text-[#8A9BA8]" title="Annualized ROI">
                    APY {apy.toFixed(0)}x
                  </span>
                )}
              </div>

              {/* Row 2: leg breakdown (always visible, no expanding) */}
              {breakdown.legs.length > 0 && (
                <div className="mt-2">
                  <LegBreakdown breakdown={breakdown} formatCurrency={formatCurrency} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}