'use client';

import React from 'react';

interface Outcome {
  artist: string;
  kalshi?: { yesAsk: number } | null;
  polymarket?: { yesPrice: number } | null;
  arbitrage: {
    expectedProfit: number;
    roiPct: number;
    kalshiStake?: number;
    pmStake?: number;
    strategy: string;
  };
}

interface OutcomeTableBodyProps {
  outcomes: Outcome[];
  expandedArtist: string | null;
  setExpandedArtist: (artist: string | null) => void;
  formatCurrency: (n: number) => string;
  formatPercent: (n: number) => string;
}

export function OutcomeTableBody({
  outcomes,
  expandedArtist,
  setExpandedArtist,
  formatCurrency,
  formatPercent,
}: OutcomeTableBodyProps) {
  const profitableOutcomes = outcomes.filter(o => o.arbitrage.expectedProfit > 0);
  const totalProfit = profitableOutcomes.reduce((s, o) => s + o.arbitrage.expectedProfit, 0);
  const highestProfitOutcome = profitableOutcomes.length > 0
    ? profitableOutcomes.reduce((best, o) => o.arbitrage.expectedProfit > best.arbitrage.expectedProfit ? o : best)
    : null;
  const showTotal = profitableOutcomes.length > 1;

  return (
    <tbody className="divide-y divide-[#1a1a1a]">
      {outcomes.map((o) => {
        const spread = o.kalshi && o.polymarket ? (o.polymarket.yesPrice - o.kalshi.yesAsk) : 0;
        const profit = o.arbitrage.expectedProfit;
        const roiColor = o.arbitrage.roiPct > 0 ? "text-[#22c55e]" : o.arbitrage.roiPct < 0 ? "text-[#ef4444]" : "text-[#737373]";
        const isExpanded = expandedArtist === o.artist;
        const totalStake = (o.arbitrage.kalshiStake ?? 0) + (o.arbitrage.pmStake ?? 0);
        const stakeRatio = totalStake > 0
          ? Math.max(o.arbitrage.kalshiStake ?? 0, o.arbitrage.pmStake ?? 0) / Math.min(o.arbitrage.kalshiStake ?? 0, o.arbitrage.pmStake ?? 0)
          : 1;
        const isBalanced = totalStake > 0 && stakeRatio <= 1.25;
        const isHighestProfit = highestProfitOutcome !== null && o.artist === highestProfitOutcome.artist && showTotal;

        return (
          <React.Fragment key={o.artist}>
            <tr
              className={`hover:bg-[#1a1a1a]/50 transition-colors cursor-pointer ${isExpanded ? "bg-[#1a1a1a]/30" : ""}`}
              onClick={() => setExpandedArtist(isExpanded ? null : o.artist)}
            >
              <td className="px-4 py-3 font-medium text-[#e5e5e5] flex items-center gap-1.5">
                <span className={`transition-transform text-[#737373] ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                {o.artist}
              </td>
              <td className="px-4 py-3 text-right text-[#e5e5e5]">{o.kalshi?.yesAsk.toFixed(2) ?? "—"}</td>
              <td className="px-4 py-3 text-right text-[#e5e5e5]">{o.polymarket?.yesPrice.toFixed(2) ?? "—"}</td>
              <td className={`px-4 py-3 text-right font-medium ${spread > 0 ? "text-[#22c55e]" : spread < 0 ? "text-[#ef4444]" : "text-[#737373]"}`}>
                {spread > 0 ? "+" : ""}{spread.toFixed(2)}
              </td>
              <td className={`px-4 py-3 text-right font-bold ${roiColor}`}>{formatPercent(o.arbitrage.roiPct)}</td>
              <td className="relative px-4 py-3 text-right">
                {profit > 0 ? (
                  isHighestProfit ? (
                    <div className="group inline-block">
                      <span className="text-[#e5e5e5] cursor-help">
                        {formatCurrency(profit)} <span className="text-[#737373]">({formatCurrency(totalProfit)} total)</span>
                      </span>
                      <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-56 bg-[#111111] border border-[#262626] rounded-lg shadow-xl p-3 text-xs">
                        <div className="font-bold text-[#e5e5e5] mb-2">Total Profit Potential</div>
                        <div className="text-[#22c55e] font-bold text-sm mb-1">{formatCurrency(totalProfit)}</div>
                        <div className="text-[#737373] text-[10px] mb-2">{profitableOutcomes.length} profitable outcome{profitableOutcomes.length > 1 ? "s" : ""}</div>
                        <div className="border-t border-[#1a1a1a] pt-2 space-y-1">
                          {profitableOutcomes.map((po) => (
                            <div key={po.artist} className="flex justify-between items-center">
                              <span className={po.artist === o.artist ? "text-[#e5e5e5] font-medium" : "text-[#737373]"}>{po.artist}</span>
                              <span className={po.artist === o.artist ? "text-[#22c55e] font-bold" : "text-[#a3a3a3]"}>{formatCurrency(po.arbitrage.expectedProfit)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <span className="text-[#e5e5e5]">{formatCurrency(profit)}</span>
                  )
                ) : "—"}
              </td>
              <td className="px-4 py-3 text-right">
                {totalStake > 0 ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-medium ${isBalanced ? "text-[#22c55e]" : "text-[#f97316]"}`}>
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${isBalanced ? "bg-[#22c55e]" : "bg-[#f97316]"}`}></span>
                    {formatCurrency(totalStake * 100)}
                  </span>
                ) : "—"}
              </td>
              <td className="px-4 py-3 text-xs text-[#a3a3a3]">{o.arbitrage.strategy}</td>
            </tr>
            {isExpanded && (
              <tr className="bg-[#111111]/50">
                <td colSpan={8} className="px-4 py-3">
                  <div className="flex items-center gap-6 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-[#737373]">Total Stake:</span>
                      <span className="font-bold text-[#e5e5e5]">{formatCurrency(totalStake * 100)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[#737373]">Breakdown:</span>
                      <span className="text-[#60a5fa]">Kalshi: {formatCurrency((o.arbitrage.kalshiStake ?? 0) * 100)}</span>
                      <span className="text-[#737373]">|</span>
                      <span className="text-[#f472b6]">Polymarket: {formatCurrency((o.arbitrage.pmStake ?? 0) * 100)}</span>
                    </div>
                    <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${isBalanced ? "bg-[#22c55e]/10 text-[#22c55e]" : "bg-[#f97316]/10 text-[#f97316]"}`}>
                      {isBalanced ? "● Balanced" : "● Imbalanced"}
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </React.Fragment>
        );
      })}
    </tbody>
  );
}
