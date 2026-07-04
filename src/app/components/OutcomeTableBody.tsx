'use client';

import React, { useState } from 'react';
import { Zap } from 'lucide-react';
import { ExecutionReadiness } from './ExecutionReadiness';
import { ExecuteArbModal, buildExecutableArb, type ExecutableArb } from './ExecuteArbModal';

interface Outcome {
  artist: string;
  kalshi?: { ticker?: string; yesAsk: number; noAsk: number; yesAskDepth?: string; noAskDepth?: string } | null;
  polymarket?: { conditionId?: string; yesPrice: number; noPrice: number; askDepth?: number; noAskDepth?: number } | null;
  arbitrage: {
    expectedProfit: number;
    roiPct: number;
    kalshiStake?: number;
    pmStake?: number;
    strategy: string;
    fees?: {
      kalshiFee: number;
      pmFee: number;
      kalshiFeeDetails: string;
      pmFeeDetails: string;
      netProfitIfKalshiWins: number;
      netProfitIfPmWins: number;
      worstCaseNetProfit: number;
    };
  };
}

interface OutcomeTableBodyProps {
  outcomes: Outcome[];
  expandedArtist: string | null;
  setExpandedArtist: (artist: string | null) => void;
  formatCurrency: (n: number) => string;
  formatPercent: (n: number) => string;
  priceChanges?: Map<string, "up" | "down" | null>;
  filterMode?: "all" | "matched" | "arb";
  /** EXEC-002: market title for the manual-execute modal. Execute buttons render only when provided. */
  marketTitle?: string;
}

export function OutcomeTableBody({
  outcomes,
  expandedArtist,
  setExpandedArtist,
  formatCurrency,
  formatPercent,
  priceChanges,
  filterMode,
  marketTitle,
}: OutcomeTableBodyProps) {
  const safeOutcomes = outcomes ?? [];

  // EXEC-002: manual-execute state — modal + per-row token resolution
  const [executingArb, setExecutingArb] = useState<ExecutableArb | null>(null);
  const [resolvingArtist, setResolvingArtist] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  const startExecute = async (o: Outcome) => {
    if (!marketTitle || !o.kalshi?.ticker || !o.polymarket?.conditionId) return;
    setResolvingArtist(o.artist);
    setExecError(null);
    try {
      const res = await fetch(`/api/pm-tokens?conditionId=${encodeURIComponent(o.polymarket.conditionId)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Token resolution failed');
      const exec = buildExecutableArb({
        artist: o.artist,
        strategy: o.arbitrage.strategy,
        roiPct: o.arbitrage.roiPct,
        expectedProfit: o.arbitrage.expectedProfit,
        kalshiStake: o.arbitrage.kalshiStake ?? 0,
        pmStake: o.arbitrage.pmStake ?? 0,
        kalshiYesAsk: o.kalshi.yesAsk ?? null,
        kalshiNoAsk: o.kalshi.noAsk ?? null,
        pmYesAsk: o.polymarket.yesPrice ?? null,
        pmNoAsk: o.polymarket.noPrice ?? null,
        kalshiTicker: o.kalshi.ticker,
        pmYesTokenId: data.yesTokenId,
        pmNoTokenId: data.noTokenId,
      }, marketTitle);
      if (!exec) throw new Error('Strategy not executable from this button (cross-outcome or missing prices)');
      setExecutingArb(exec);
    } catch (e: any) {
      setExecError(`${o.artist}: ${e.message}`);
    } finally {
      setResolvingArtist(null);
    }
  };

  const displayOutcomes = filterMode === "arb"
    ? safeOutcomes.filter(o => o.arbitrage.expectedProfit > 0)
    : filterMode === "matched"
      ? safeOutcomes.filter(o => o.kalshi && o.polymarket)
      : safeOutcomes;

  const profitableOutcomes = safeOutcomes.filter(o => o.kalshi && o.polymarket && o.arbitrage.expectedProfit > 0);
  const totalProfit = profitableOutcomes.reduce((s, o) => s + o.arbitrage.expectedProfit, 0);
  const highestProfitOutcome = profitableOutcomes.length > 0
    ? profitableOutcomes.reduce((best, o) => o.arbitrage.expectedProfit > best.arbitrage.expectedProfit ? o : best)
    : null;
  const showTotal = profitableOutcomes.length > 1;

  return (
    <tbody className="divide-y divide-[#182533]">
      {displayOutcomes.map((o, idx) => {
        const k = o.kalshi;
        const p = o.polymarket;
        const hasPrices = !!(k && p && k.yesAsk != null && p.yesPrice != null);
        // Compute spread based on the actual arbitrage strategy used
        let spread: number | null = null;
        if (hasPrices) {
          const strategy = o.arbitrage.strategy;
          if (strategy === 'Buy YES Kalshi + NO PM') {
            spread = (1 - (k!.yesAsk + p!.noPrice)) * 100;
          } else if (strategy === 'Buy YES PM + NO Kalshi') {
            spread = (1 - (p!.yesPrice + k!.noAsk)) * 100;
          } else if (strategy.startsWith('Buy YES both sides')) {
            spread = (1 - (k!.yesAsk + p!.yesPrice)) * 100;
          } else {
            // Fallback: use the simpler spread calculation
            spread = (p!.yesPrice - k!.yesAsk) * 100;
          }
        }
        const profit = hasPrices ? o.arbitrage.expectedProfit : 0;
        const roiColor = !hasPrices ? "text-[#5E6875]" : o.arbitrage.roiPct > 0 ? "text-[#5DBE81]" : o.arbitrage.roiPct < 0 ? "text-[#ef4444]" : "text-[#5E6875]";
        const isExpanded = expandedArtist === o.artist;
        const totalStake = (o.arbitrage.kalshiStake ?? 0) + (o.arbitrage.pmStake ?? 0);
        const stakeRatio = totalStake > 0
          ? Math.max(o.arbitrage.kalshiStake ?? 0, o.arbitrage.pmStake ?? 0) / Math.min(o.arbitrage.kalshiStake ?? 0, o.arbitrage.pmStake ?? 0)
          : 1;
        const isBalanced = totalStake > 0 && stakeRatio <= 1.25;
        const isHighestProfit = highestProfitOutcome !== null && o.artist === highestProfitOutcome.artist && showTotal;

        return (
          <React.Fragment key={`${idx}-${o.artist}`}>
            <tr
              className={`hover:bg-[#182533]/50 transition-colors cursor-pointer ${isExpanded ? "bg-[#182533]/30" : ""}`}
              onClick={() => setExpandedArtist(isExpanded ? null : o.artist)}
            >
              <td className="px-4 py-3 font-medium text-[#FFFFFF]">
                <div className="flex items-center gap-1.5">
                  <span className={`transition-transform text-[#5E6875] ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                  {o.artist}
                </div>
              </td>
              <td className="px-4 py-3 text-right text-[#FFFFFF]">
                {o.kalshi?.yesAsk.toFixed(2) ?? "—"}
                {priceChanges?.get(o.artist) === "up" && <span className="ml-1 animate-pulse text-[#5DBE81]">▲</span>}
                {priceChanges?.get(o.artist) === "down" && <span className="ml-1 animate-pulse text-[#ef4444]">▼</span>}
              </td>
              <td className="px-4 py-3 text-right text-[#5E6875]">{o.kalshi?.noAsk.toFixed(2) ?? "—"}</td>
              <td className="px-4 py-3 text-right text-[#FFFFFF]">
                {o.polymarket?.yesPrice.toFixed(2) ?? "—"}
                {priceChanges?.get(o.artist) === "up" && <span className="ml-1 animate-pulse text-[#5DBE81]">▲</span>}
                {priceChanges?.get(o.artist) === "down" && <span className="ml-1 animate-pulse text-[#ef4444]">▼</span>}
              </td>
              <td className="px-4 py-3 text-right text-[#5E6875]">{o.polymarket?.noPrice.toFixed(2) ?? "—"}</td>
              <td className={`px-4 py-3 text-right font-medium ${spread != null && spread > 0 ? "text-[#5DBE81]" : spread != null && spread < 0 ? "text-[#ef4444]" : "text-[#5E6875]"}`}>
                {spread != null ? `${spread > 0 ? "+" : ""}${spread.toFixed(2)}` : "—"}
              </td>
              <td className={`px-4 py-3 text-right font-bold ${roiColor}`}>{hasPrices ? formatPercent(o.arbitrage.roiPct) : "—"}</td>
              <td className="relative px-4 py-3 text-right group">
                {!hasPrices || profit <= 0 ? (
                  <span className="text-[#5E6875]">—</span>
                ) : profit > 0 ? (
                  isHighestProfit ? (
                    <div className="group inline-block">
                      <span className="text-[#FFFFFF] cursor-help">
                        {formatCurrency(profit)} <span className="text-[#5E6875]">({formatCurrency(totalProfit)} total)</span>
                      </span>
                      <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-72 bg-[#17212B] border border-[#232E3C] rounded-lg shadow-xl p-3 text-xs">
                        <div className="font-bold text-[#FFFFFF] mb-2">Total Profit Potential (after fees)</div>
                        <div className="text-[#5DBE81] font-bold text-sm mb-1">{formatCurrency(totalProfit)}</div>
                        <div className="text-[#5E6875] text-[10px] mb-2">{profitableOutcomes.length} profitable outcome{profitableOutcomes.length > 1 ? "s" : ""}</div>
                        {o.arbitrage.fees && (
                          <div className="border-t border-[#182533] pt-2 mb-2 space-y-1">
                            <div className="text-[#5E6875]">{o.arbitrage.fees.kalshiFeeDetails}</div>
                            <div className="text-[#5E6875]">{o.arbitrage.fees.pmFeeDetails}</div>
                            <div className="flex justify-between text-[#FFFFFF] font-medium">
                              <span>Worst-case net profit</span>
                              <span className={o.arbitrage.fees.worstCaseNetProfit >= 0 ? "text-[#5DBE81]" : "text-[#ef4444]"}>{formatCurrency(o.arbitrage.fees.worstCaseNetProfit)}</span>
                            </div>
                          </div>
                        )}
                        <div className="border-t border-[#182533] pt-2 space-y-1">
                          {profitableOutcomes.map((po, pidx) => (
                            <div key={`${pidx}-${po.artist}`} className="flex justify-between items-center">
                              <span className={po.artist === o.artist ? "text-[#FFFFFF] font-medium" : "text-[#5E6875]"}>{po.artist}</span>
                              <span className={po.artist === o.artist ? "text-[#5DBE81] font-bold" : "text-[#8A9BA8]"}>{formatCurrency(po.arbitrage.expectedProfit)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="group inline-block">
                      <span className="text-[#FFFFFF] cursor-help">{formatCurrency(profit)}</span>
                      {o.arbitrage.fees && (
                        <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-72 bg-[#17212B] border border-[#232E3C] rounded-lg shadow-xl p-3 text-xs">
                          <div className="font-bold text-[#FFFFFF] mb-2">Profit after fees</div>
                          <div className="text-[#5DBE81] font-bold text-sm mb-1">{formatCurrency(profit)}</div>
                          <div className="border-t border-[#182533] pt-2 space-y-1">
                            <div className="text-[#5E6875]">{o.arbitrage.fees.kalshiFeeDetails}</div>
                            <div className="text-[#5E6875]">{o.arbitrage.fees.pmFeeDetails}</div>
                            <div className="flex justify-between text-[#FFFFFF] font-medium border-t border-[#182533] pt-1">
                              <span>Worst-case net profit</span>
                              <span className={o.arbitrage.fees.worstCaseNetProfit >= 0 ? "text-[#5DBE81]" : "text-[#ef4444]"}>{formatCurrency(o.arbitrage.fees.worstCaseNetProfit)}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                ) : "—"}
              </td>
              <td className="px-4 py-3 text-right">
                {totalStake > 0 ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-medium ${isBalanced ? "text-[#5DBE81]" : "text-[#ef4444]"}`}>
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${isBalanced ? "bg-[#5DBE81]" : "bg-[#ef4444]"}`}></span>
                    {formatCurrency(totalStake)}
                  </span>
                ) : "—"}
              </td>
              <td className="px-4 py-3 text-xs">
                {!hasPrices ? (
                  <span className="text-[#5E6875]">—</span>
                ) : o.arbitrage.strategy === 'No arb' ? (
                  <span className="text-[#5E6875]">No arb</span>
                ) : o.arbitrage.strategy.startsWith('Buy YES both sides') ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#ef4444]/20 text-[#ef4444]">CROSS</span>
                    <span className="text-[#8A9BA8]">{o.arbitrage.strategy.replace(/^Buy YES both sides: Kalshi (.+?) \+ PM (.+)$/, '$1 + $2')}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <span className="text-[#8A9BA8]">{o.arbitrage.strategy}</span>
                    {/* EXEC-002: manual execute — only for simple 2-leg positive arbs */}
                    {marketTitle && o.arbitrage.roiPct > 0 && !(o.arbitrage as any).suspicious && o.kalshi?.ticker && o.polymarket?.conditionId && (
                      <button
                        onClick={(e) => { e.stopPropagation(); startExecute(o); }}
                        disabled={resolvingArtist === o.artist}
                        className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-[#facc15]/20 text-[#facc15] hover:bg-[#facc15]/40 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                        title="Manually execute this arb (opens confirmation)"
                      >
                        <Zap className="w-2.5 h-2.5" /> {resolvingArtist === o.artist ? "..." : "Execute"}
                      </button>
                    )}
                  </span>
                )}
              </td>
            </tr>
            {isExpanded && (
              <tr className="bg-[#17212B]/50">
                <td colSpan={8} className="px-4 py-3">
                  <div className="flex items-center gap-6 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-[#5E6875]">Total Stake:</span>
                      <span className="font-bold text-[#FFFFFF]">{formatCurrency(totalStake)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[#5E6875]">Breakdown:</span>
                      <span className="text-[#5DBE81]">Kalshi: {formatCurrency(o.arbitrage.kalshiStake ?? 0)}</span>
                      <span className="text-[#5E6875]">|</span>
                      <span className="text-[#ef4444]">Polymarket: {formatCurrency(o.arbitrage.pmStake ?? 0)}</span>
                    </div>
                    <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${isBalanced ? "bg-[#5DBE81]/10 text-[#5DBE81]" : "bg-[#ef4444]/10 text-[#ef4444]"}`}>
                      {isBalanced ? "● Balanced" : "● Imbalanced"}
                    </div>
                  </div>
                  <ExecutionReadiness
                    kalshi={o.kalshi}
                    polymarket={o.polymarket}
                    arbitrage={o.arbitrage}
                    formatCurrency={formatCurrency}
                  />
                </td>
              </tr>
            )}
          </React.Fragment>
        );
      })}
      {/* EXEC-002: token-resolution error + confirmation modal */}
      {execError && (
        <tr><td colSpan={10} className="px-4 py-2 text-xs text-[#ef4444]">{execError}</td></tr>
      )}
      {executingArb && (
        <tr><td colSpan={10}>
          <ExecuteArbModal arb={executingArb} onClose={() => setExecutingArb(null)} />
        </td></tr>
      )}
    </tbody>
  );
}
