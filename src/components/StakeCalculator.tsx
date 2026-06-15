"use client";

import React, { useState, useMemo } from "react";
import { DollarSign, Calculator, TrendingUp, ArrowRight, Wallet } from "lucide-react";

interface StakeSuggestion {
  artist: string;
  strategy: string;
  kalshiStake: number;
  pmStake: number;
  totalStake: number;
  expectedProfit: number;
  roiPct: number;
  apyPct?: number;
}

interface StakeCalculatorProps {
  suggestions: StakeSuggestion[];
  defaultCapital?: number;
  onCapitalChange?: (capital: number) => void;
}

export function StakeCalculator({ suggestions, defaultCapital = 1000, onCapitalChange }: StakeCalculatorProps) {
  const [capital, setCapital] = useState(defaultCapital);
  const [showDetails, setShowDetails] = useState(false);

  const handleCapitalChange = (value: number) => {
    setCapital(value);
    onCapitalChange?.(value);
  };

  // Calculate automatic distribution
  const distribution = useMemo(() => {
    if (!suggestions.length) return [];

    // Filter positive arbitrage opportunities
    const positiveArbs = suggestions.filter(s => s.expectedProfit > 0);
    if (!positiveArbs.length) return [];

    // Sort by ROI descending
    const sorted = [...positiveArbs].sort((a, b) => b.roiPct - a.roiPct);

    // Calculate total optimal stake
    const totalOptimalStake = sorted.reduce((sum, s) => sum + s.totalStake, 0);

    // Distribute capital proportionally
    return sorted.map(s => {
      const ratio = totalOptimalStake > 0 ? s.totalStake / totalOptimalStake : 0;
      const allocatedCapital = capital * ratio;
      const scaledProfit = s.roiPct > 0 ? allocatedCapital * (s.roiPct / 100) : 0;
      const kRatio = s.totalStake > 0 ? s.kalshiStake / s.totalStake : 0;
      const pRatio = s.totalStake > 0 ? s.pmStake / s.totalStake : 0;

      return {
        ...s,
        allocatedCapital,
        allocatedKalshi: allocatedCapital * kRatio,
        allocatedPm: allocatedCapital * pRatio,
        scaledProfit,
        ratio,
      };
    });
  }, [suggestions, capital]);

  const totalProfit = useMemo(() => distribution.reduce((sum, d) => sum + d.scaledProfit, 0), [distribution]);
  const avgRoi = useMemo(() => {
    if (!distribution.length) return 0;
    const totalAllocated = distribution.reduce((sum, d) => sum + d.allocatedCapital, 0);
    return totalAllocated > 0 ? (totalProfit / totalAllocated) * 100 : 0;
  }, [distribution, totalProfit]);

  return (
    <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#182533]">
        <div className="flex items-center gap-2">
          <Calculator className="w-4 h-4 text-[#5DBE81]" />
          <span className="text-sm font-semibold text-[#FFFFFF]">Stake Calculator</span>
        </div>
        <div className="flex items-center gap-2">
          <Wallet className="w-3.5 h-3.5 text-[#5E6875]" />
          <span className="text-xs text-[#5E6875]">Capital:</span>
          <input
            type="number"
            value={capital}
            onChange={(e) => handleCapitalChange(Number(e.target.value))}
            className="w-24 px-2 py-1 rounded-lg border border-[#232E3C] bg-[#0E1621] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
          />
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3 p-4 border-b border-[#182533]">
        <div className="rounded-lg bg-[#121E2B] border border-[#182533] p-3">
          <div className="text-[10px] text-[#5E6875] uppercase tracking-wider mb-1">Total Allocated</div>
          <div className="text-lg font-bold text-[#FFFFFF]">
            ${distribution.reduce((sum, d) => sum + d.allocatedCapital, 0).toFixed(2)}
          </div>
        </div>
        <div className="rounded-lg bg-[#121E2B] border border-[#182533] p-3">
          <div className="text-[10px] text-[#5E6875] uppercase tracking-wider mb-1">Expected Profit</div>
          <div className="text-lg font-bold text-[#5DBE81]">
            +${totalProfit.toFixed(2)}
          </div>
        </div>
        <div className="rounded-lg bg-[#121E2B] border border-[#182533] p-3">
          <div className="text-[10px] text-[#5E6875] uppercase tracking-wider mb-1">Avg ROI</div>
          <div className="text-lg font-bold text-[#5DBE81]">
            {avgRoi.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Distribution table */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-[#5E6875]">Auto-distribution across {distribution.length} opportunities</span>
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="text-xs text-[#5DBE81] hover:text-[#4DA66E] transition-colors"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
        </div>

        {showDetails && (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {distribution.map((d, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg bg-[#121E2B] border border-[#182533] p-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[#FFFFFF] truncate">{d.artist}</div>
                  <div className="text-[10px] text-[#5E6875] mt-0.5">{d.strategy}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-bold text-[#5DBE81]">
                    ${d.allocatedCapital.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-[#5E6875]">
                    K: ${d.allocatedKalshi.toFixed(0)} / PM: ${d.allocatedPm.toFixed(0)}
                  </div>
                </div>
                <div className="text-right shrink-0 w-20">
                  <div className="text-xs font-bold text-[#5DBE81]">
                    +${d.scaledProfit.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-[#5E6875]">
                    {d.roiPct.toFixed(1)}% ROI
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
