'use client';

import React, { useState, useMemo } from 'react';
import { Zap } from 'lucide-react';
import { ExecutionReadiness } from './ExecutionReadiness';
import { ExecuteArbModal, buildExecutableArb, type ExecutableArb } from './ExecuteArbModal';
import { ArbHistoryCell } from './ArbHistoryCell';
import { ExpandedChart } from './ExpandedChart';
import { ArbDecayCurve } from './ArbDecayCurve';
import { DepthHeatmap, computeLiquidityFromOutcome } from './DepthHeatmap';
import { parseArbLegs, LegBreakdown, ArbTypeBadge } from './ArbLegBreakdown';
import { ApyValueTooltip, getDaysToExpiry, buildMarketTooltip } from './ApyTooltip';

interface Outcome {
  artist: string;
  kalshi?: { ticker?: string; yesAsk: number; noAsk: number; yesAskDepth?: string; noAskDepth?: string } | null;
  polymarket?: { conditionId?: string; yesPrice: number; noPrice: number; askDepth?: number; noAskDepth?: number } | null;
  arbitrage: {
    expectedProfit: number;
    roiPct: number;
    apyPct?: number;
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
  /** UI-05: market id for arbitrage history sparkline */
  marketId?: string;
  /** UI-06: sort field for the outcome table */
  sortField?: "roi" | "apy" | "profit";
  /** UI-06: sort direction for the outcome table */
  sortDir?: "asc" | "desc";
  /** UI-15: market expiry date for APY tooltip breakdown */
  marketExpiryDate?: string | null;
}

/** Format days-to-expiry as human-readable string:
 *  >1 day → "X days", <1 day → "X hours" or "X min", expired → "Expired" */
function formatTimeToExpiry(expiryDate?: string | null): string {
  const days = getDaysToExpiry(expiryDate);
  if (days == null) return "Expired";
  if (days >= 1) return `${Math.round(days)} days`;
  const hours = days * 24;
  if (hours >= 1) return `${Math.round(hours)} hours`;
  const mins = hours * 60;
  if (mins >= 1) return `${Math.round(mins)} min`;
  return "Expired";
}

function OutcomeTableBodyInner({
  outcomes,
  expandedArtist,
  setExpandedArtist,
  formatCurrency,
  formatPercent,
  priceChanges,
  filterMode,
  marketTitle,
  marketId,
  sortField,
  sortDir,
  marketExpiryDate,
}: OutcomeTableBodyProps) {
  const safeOutcomes = outcomes ?? [];

  // EXEC-002: manual-execute state — modal + per-row token resolution
  const [executingArb, setExecutingArb] = useState<ExecutableArb | null>(null);
  const [resolvingArtist, setResolvingArtist] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  // Sparkline expand state — which artist's chart is expanded (independent of row expand)
  const [expandedChartArtist, setExpandedChartArtist] = useState<string | null>(null);

  const startExecute = async (o: Outcome) => {
    // Show clear error instead of silent return
    if (!marketTitle) {
      setExecError('Cannot execute: market title missing. Wait for scan to complete.');
      return;
    }
    if (!o.kalshi?.ticker) {
      setExecError(`Cannot execute ${o.artist}: Kalshi ticker missing. Wait for live scan to complete.`);
      return;
    }
    if (!o.polymarket?.conditionId) {
      setExecError(`Cannot execute ${o.artist}: Polymarket conditionId missing. Wait for live scan to complete.`);
      return;
    }
    setResolvingArtist(o.artist);
    setExecError(null);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`/api/pm-tokens?conditionId=${encodeURIComponent(o.polymarket.conditionId)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
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
      if (!exec) {
        // Provide specific reason why it's not executable
        const kStake = o.arbitrage.kalshiStake ?? 0;
        const pmStake = o.arbitrage.pmStake ?? 0;
        const kYesAsk = o.kalshi?.yesAsk ?? null;
        const kNoAsk = o.kalshi?.noAsk ?? null;
        const pmYes = o.polymarket?.yesPrice ?? null;
        const pmNo = o.polymarket?.noPrice ?? null;
        let reason = 'Unknown reason';
        if (o.arbitrage.strategy !== 'Buy YES Kalshi + NO PM' && o.arbitrage.strategy !== 'Buy YES PM + NO Kalshi') {
          reason = `Strategy "${o.arbitrage.strategy}" not supported for direct execution (only 2-leg arbs)`;
        } else if (kStake <= 0 || pmStake <= 0) {
          reason = `Stakes are zero (Kalshi: ${kStake}, PM: ${pmStake}). Wait for live scan data.`;
        } else if (o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' && (kYesAsk == null || pmNo == null)) {
          reason = `Missing prices: Kalshi YES ask=${kYesAsk}, PM NO price=${pmNo}`;
        } else if (o.arbitrage.strategy === 'Buy YES PM + NO Kalshi' && (kNoAsk == null || pmYes == null)) {
          reason = `Missing prices: Kalshi NO ask=${kNoAsk}, PM YES price=${pmYes}`;
        }
        throw new Error(`${o.artist}: ${reason}`);
      }
      setExecutingArb(exec);
    } catch (e: any) {
      const msg = e.name === 'AbortError'
        ? `Timed out resolving Polymarket tokens for ${o.artist}. The CLOB API may be slow. Try again.`
        : `${o.artist}: ${e.message}`;
      setExecError(msg);
    } finally {
      setResolvingArtist(null);
    }
  };

  const displayOutcomes = useMemo(() => {
    // BUG-01: "Arb Only" filter definition — an outcome counts as an active arb
    // when expectedProfit > 0 (net of fees). This is the per-market outcome
    // filter, separate from the dashboard "Active Arbs Now" counter which
    // counts markets (not outcomes) with bestRoiPct > 0 from saved_markets.
    let arr = filterMode === "arb"
      ? safeOutcomes.filter(o => o.arbitrage.expectedProfit > 0)
      : filterMode === "matched"
        ? safeOutcomes.filter(o => o.kalshi && o.polymarket)
        : safeOutcomes;
    if (sortField) {
      const mul = sortDir === "asc" ? 1 : -1;
      arr = [...arr].sort((a, b) => {
        const va = sortField === "roi" ? a.arbitrage.roiPct : sortField === "apy" ? (a.arbitrage.apyPct ?? 0) : a.arbitrage.expectedProfit;
        const vb = sortField === "roi" ? b.arbitrage.roiPct : sortField === "apy" ? (b.arbitrage.apyPct ?? 0) : b.arbitrage.expectedProfit;
        return mul * (va - vb);
      });
    }
    return arr;
  }, [safeOutcomes, filterMode, sortField, sortDir]);

  const profitableOutcomes = displayOutcomes.filter(o => o.kalshi && o.polymarket && o.arbitrage.expectedProfit > 0);
  const accumulatedProfit = profitableOutcomes.reduce((s, o) => s + o.arbitrage.expectedProfit, 0);
  // UI-13: Accumulated fee totals for footer hover breakdown
  const accumulatedKalshiFees = profitableOutcomes.reduce((s, o) => s + (o.arbitrage.fees?.kalshiFee ?? 0), 0);
  const accumulatedPmFees = profitableOutcomes.reduce((s, o) => s + (o.arbitrage.fees?.pmFee ?? 0), 0);
  const accumulatedGrossProfit = accumulatedProfit + accumulatedKalshiFees + accumulatedPmFees;
  const hasFeeBreakdown = profitableOutcomes.some(o => o.arbitrage.fees);

  return (
    <>
    <tbody className="divide-y divide-[#182533]">
      {displayOutcomes.map((o, idx) => {
        const k = o.kalshi;
        const p = o.polymarket;
        const hasPrices = !!(k && p && k.yesAsk != null && p.yesPrice != null);
        const profit = hasPrices ? o.arbitrage.expectedProfit : 0;
        const roiColor = !hasPrices ? "text-[#8A9BA8]" : o.arbitrage.roiPct > 0 ? "text-[#5DBE81]" : o.arbitrage.roiPct < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]";
        // APY color: gray for non-actionable (no prices, ROI <= 0, or APY <= 0); green only when ROI is positive and APY is positive
        const apyColor = !hasPrices || o.arbitrage.roiPct <= 0 || (o.arbitrage.apyPct ?? 0) <= 0 ? "text-[#8A9BA8]" : "text-[#5DBE81]";
        const isExpanded = expandedArtist === o.artist;
        const totalStake = (o.arbitrage.kalshiStake ?? 0) + (o.arbitrage.pmStake ?? 0);
        const stakeRatio = totalStake > 0
          ? Math.max(o.arbitrage.kalshiStake ?? 0, o.arbitrage.pmStake ?? 0) / Math.min(o.arbitrage.kalshiStake ?? 0, o.arbitrage.pmStake ?? 0)
          : 1;
        const isBalanced = totalStake > 0 && stakeRatio <= 1.25;

        return (
          <React.Fragment key={`${idx}-${o.artist}`}>
            <tr
              className={`hover:bg-[#182533]/50 transition-colors cursor-pointer ${isExpanded ? "bg-[#182533]/30" : ""}`}
              onClick={() => setExpandedArtist(isExpanded ? null : o.artist)}
            >
              <td className="px-4 py-3 font-medium text-[#FFFFFF]">
                <div className="flex items-center gap-1.5" title={buildMarketTooltip({ eventTitle: marketTitle ?? o.artist, expiryDate: marketExpiryDate })}>
                  <span className={`transition-transform text-[#8A9BA8] ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                  {o.artist}
                </div>
              </td>
              <td className="px-4 py-3 text-right text-[#FFFFFF]">
                {o.kalshi?.yesAsk.toFixed(2) ?? "—"}
                {priceChanges?.get(o.artist) === "up" && <span className="ml-1 animate-pulse text-[#5DBE81]">▲</span>}
                {priceChanges?.get(o.artist) === "down" && <span className="ml-1 animate-pulse text-[#ef4444]">▼</span>}
              </td>
              <td className="px-4 py-3 text-right text-[#8A9BA8]">{o.kalshi?.noAsk.toFixed(2) ?? "—"}</td>
              <td className="px-4 py-3 text-right text-[#FFFFFF]">
                {o.polymarket?.yesPrice.toFixed(2) ?? "—"}
                {priceChanges?.get(o.artist) === "up" && <span className="ml-1 animate-pulse text-[#5DBE81]">▲</span>}
                {priceChanges?.get(o.artist) === "down" && <span className="ml-1 animate-pulse text-[#ef4444]">▼</span>}
              </td>
              <td className="px-4 py-3 text-right text-[#8A9BA8]">{o.polymarket?.noPrice.toFixed(2) ?? "—"}</td>
              <td className={`px-4 py-3 text-right font-bold ${roiColor}`}>{hasPrices ? formatPercent(o.arbitrage.roiPct) : "—"}</td>
              <td className={`px-4 py-3 text-right font-medium ${apyColor}`}>
                {hasPrices && o.arbitrage.apyPct != null ? (
                  <ApyValueTooltip apy={o.arbitrage.apyPct} roi={o.arbitrage.roiPct} daysToExpiry={getDaysToExpiry(marketExpiryDate)}>
                    {formatPercent(o.arbitrage.apyPct)}
                  </ApyValueTooltip>
                ) : "—"}
              </td>
              <td className="relative px-4 py-3 text-right group">
                {!hasPrices || profit <= 0 ? (
                  <span className="text-[#8A9BA8]">—</span>
                ) : profit > 0 ? (
                  <div className="group inline-block">
                    <span className="text-[#FFFFFF] cursor-help">{formatCurrency(profit)}</span>
                    {o.arbitrage.fees && (
                      <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-72 bg-[#17212B] border border-[#232E3C] rounded-lg shadow-xl p-3 text-xs">
                        <div className="font-bold text-[#FFFFFF] mb-2">Fee Breakdown</div>
                        <div className="space-y-1 mb-2">
                          <div className="flex justify-between text-[#8A9BA8]">
                            <span>Gross profit</span>
                            <span className="text-[#FFFFFF]">{formatCurrency(profit + o.arbitrage.fees.kalshiFee + o.arbitrage.fees.pmFee)}</span>
                          </div>
                          <div className="flex justify-between text-[#8A9BA8]">
                            <span>Kalshi fee</span>
                            <span className="text-[#ef4444]">-{formatCurrency(o.arbitrage.fees.kalshiFee)}</span>
                          </div>
                          <div className="flex justify-between text-[#8A9BA8]">
                            <span>Polymarket fee</span>
                            <span className="text-[#ef4444]">-{formatCurrency(o.arbitrage.fees.pmFee)}</span>
                          </div>
                        </div>
                        <div className="flex justify-between text-[#FFFFFF] font-medium border-t border-[#182533] pt-2">
                          <span>Net profit (after fees)</span>
                          <span className="text-[#5DBE81] font-bold">{formatCurrency(profit)}</span>
                        </div>
                        <div className="border-t border-[#182533] pt-2 mt-2 space-y-1">
                          <div className="text-[#8A9BA8] text-[10px]">{o.arbitrage.fees.kalshiFeeDetails}</div>
                          <div className="text-[#8A9BA8] text-[10px]">{o.arbitrage.fees.pmFeeDetails}</div>
                          <div className="flex justify-between text-[#FFFFFF] font-medium border-t border-[#182533] pt-1">
                            <span>Worst-case net</span>
                            <span className={o.arbitrage.fees.worstCaseNetProfit >= 0 ? "text-[#5DBE81]" : "text-[#ef4444]"}>{formatCurrency(o.arbitrage.fees.worstCaseNetProfit)}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : "—"}
              </td>
              <td className="px-4 py-3 text-right">
                {(() => {
                  if (!hasPrices || !k || !p) return <span className="text-[#8A9BA8]">—</span>;
                  // UI-10: Hide stake/depth for negative-arb rows — no point showing
                  // deployable capital when there's no profitable arb.
                  if (o.arbitrage.roiPct <= 0) return <span className="text-[#8A9BA8]">—</span>;
                  const liq = computeLiquidityFromOutcome(k, p, o.arbitrage);
                  if (!liq) return <span className="text-[#8A9BA8]">—</span>;
                  return (
                    <div className="flex flex-col items-end gap-0.5">
                      <DepthHeatmap
                        maxFillableStake={liq.maxFillableStake}
                        slippageEstimate={liq.slippageEstimate}
                        warningLevel={liq.warningLevel}
                        kalshiDepth={liq.kalshiDepth}
                        polymarketDepth={liq.polymarketDepth}
                        compact
                      />
                      {totalStake > 0 && (
                        <span className={`text-[10px] font-medium ${isBalanced ? "text-[#5DBE81]" : "text-[#ef4444]"}`}>
                          {formatCurrency(totalStake)}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </td>
              <td className="px-4 py-3 text-right">
                {marketId ? <ArbHistoryCell marketId={marketId} outcomeArtist={o.artist} onExpand={() => {
                  // Toggle chart expansion; also expand the row if not already
                  setExpandedChartArtist(prev => prev === o.artist ? null : o.artist);
                  if (expandedArtist !== o.artist) setExpandedArtist(o.artist);
                }} isExpanded={expandedChartArtist === o.artist} /> : <span className="text-[#8A9BA8] text-xs">—</span>}
              </td>
              <td className="px-4 py-3 text-right">
                {marketId && o.arbitrage.roiPct > 0 ? <ArbDecayCurve marketId={marketId} outcome={o.artist} /> : <span className="text-[#8A9BA8] text-xs">—</span>}
              </td>
              <td className="px-4 py-3 text-xs">
                {!hasPrices ? (
                  <span className="text-[#8A9BA8]">—</span>
                ) : (() => {
                  if (o.arbitrage.strategy === 'No arb') {
                    return <span className="text-[#8A9BA8]">No arb</span>;
                  }
                  return (
                    <span className="inline-flex items-center gap-1.5">
                      <ArbTypeBadge strategy={o.arbitrage.strategy} arbType={(o.arbitrage as any).arbType} onClick={() => setExpandedArtist(expandedArtist === o.artist ? null : o.artist)} />
                      {/* EXEC-002: manual execute — only for simple 2-leg positive arbs */}
                      {marketTitle && o.arbitrage.roiPct > 0 && !(o.arbitrage as any).suspicious && o.kalshi?.ticker && o.polymarket?.conditionId && (
                        <span className="flex flex-col items-center">
                          <span className="text-[8px] uppercase tracking-wider text-[#8A9BA8] mb-0.5">Action</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); startExecute(o); }}
                            disabled={resolvingArtist === o.artist}
                            className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-[#facc15]/20 text-[#facc15] hover:bg-[#facc15]/40 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                            title="Manually execute this arb (opens confirmation)"
                          >
                            <Zap className="w-2.5 h-2.5" /> {resolvingArtist === o.artist ? "..." : "Execute"}
                          </button>
                        </span>
                      )}
                    </span>
                  );
                })()}
              </td>
            </tr>
            {isExpanded && (
              <tr className="bg-[#17212B]/50">
                <td colSpan={12} className="px-4 py-3">
                  <div className="flex items-center gap-6 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-[#8A9BA8]">Total Stake:</span>
                      <span className="font-bold text-[#FFFFFF]">{formatCurrency(totalStake)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[#8A9BA8]">Breakdown:</span>
                      <span className="text-[#5DBE81]">Kalshi: {formatCurrency(o.arbitrage.kalshiStake ?? 0)}</span>
                      <span className="text-[#8A9BA8]">|</span>
                      <span className="text-[#ef4444]">Polymarket: {formatCurrency(o.arbitrage.pmStake ?? 0)}</span>
                    </div>
                    <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${isBalanced ? "bg-[#5DBE81]/10 text-[#5DBE81]" : "bg-[#ef4444]/10 text-[#ef4444]"}`}>
                      {isBalanced ? "● Balanced" : "● Imbalanced"}
                    </div>
                    {/* APY in expanded detail — same value as scan table column */}
                    {hasPrices && o.arbitrage.apyPct != null && o.arbitrage.apyPct > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[#8A9BA8]">APY:</span>
                        <ApyValueTooltip apy={o.arbitrage.apyPct} roi={o.arbitrage.roiPct} daysToExpiry={getDaysToExpiry(marketExpiryDate)}>
                          <span className="font-bold text-[#5DBE81]">{formatPercent(o.arbitrage.apyPct)}</span>
                        </ApyValueTooltip>
                      </div>
                    )}
                    {/* Days to expiry in expanded detail */}
                    <div className="flex items-center gap-2">
                      <span className="text-[#8A9BA8]">Days to expiry:</span>
                      <span className={`font-medium ${formatTimeToExpiry(marketExpiryDate) === "Expired" ? "text-[#ef4444]" : "text-[#FFFFFF]"}`}>
                        {formatTimeToExpiry(marketExpiryDate)}
                      </span>
                    </div>
                  </div>
                  {/* UI-13: Fee breakdown in expanded row */}
                  {o.arbitrage.fees && (
                    <div className="mt-3 pt-3 border-t border-[#182533]">
                      <div className="text-[10px] uppercase tracking-wider text-[#8A9BA8] font-medium mb-2">Fee Breakdown</div>
                      <div className="flex items-center gap-6 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-[#8A9BA8]">Gross:</span>
                          <span className="text-[#FFFFFF] font-medium">{formatCurrency(profit + o.arbitrage.fees.kalshiFee + o.arbitrage.fees.pmFee)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[#8A9BA8]">Kalshi fee:</span>
                          <span className="text-[#ef4444]">-{formatCurrency(o.arbitrage.fees.kalshiFee)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[#8A9BA8]">PM fee:</span>
                          <span className="text-[#ef4444]">-{formatCurrency(o.arbitrage.fees.pmFee)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[#8A9BA8]">Net:</span>
                          <span className="text-[#5DBE81] font-bold">{formatCurrency(profit)}</span>
                        </div>
                      </div>
                      <div className="mt-1.5 text-[10px] text-[#8A9BA8] space-y-0.5">
                        <div>{o.arbitrage.fees.kalshiFeeDetails}</div>
                        <div>{o.arbitrage.fees.pmFeeDetails}</div>
                      </div>
                    </div>
                  )}

                  {/* UI-14: Leg breakdown — clear buy/side mapping per platform */}
                  {hasPrices && o.arbitrage.strategy !== 'No arb' && (() => {
                    const breakdown = parseArbLegs(
                      o.arbitrage.strategy,
                      o.artist,
                      o.kalshi?.yesAsk,
                      o.kalshi?.noAsk,
                      o.polymarket?.yesPrice,
                      o.polymarket?.noPrice,
                      o.arbitrage.kalshiStake,
                      o.arbitrage.pmStake,
                      o.arbitrage.fees,
                      o.arbitrage.expectedProfit,
                    );
                    return <LegBreakdown breakdown={breakdown} formatCurrency={formatCurrency} />;
                  })()}

                  <ExecutionReadiness
                    kalshi={o.kalshi}
                    polymarket={o.polymarket}
                    arbitrage={o.arbitrage}
                    formatCurrency={formatCurrency}
                  />

                  {/* Sparkline expand: full ROI history chart with axes */}
                  {marketId && expandedChartArtist === o.artist && (
                    <ExpandedChart
                      marketId={marketId}
                      outcomeArtist={o.artist}
                      onClose={() => setExpandedChartArtist(null)}
                    />
                  )}
                </td>
              </tr>
            )}
          </React.Fragment>
        );
      })}
      {/* EXEC-002: token-resolution error + confirmation modal */}
      {execError && (
        <tr><td colSpan={12} className="px-4 py-0">
          <div className="my-2 rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 px-4 py-2.5 text-xs text-[#ef4444] flex items-center gap-2">
            <span className="text-sm">⚠️</span>
            <span>{execError}</span>
            <button onClick={() => setExecError(null)} className="ml-auto text-[#ef4444]/60 hover:text-[#ef4444] text-xs">✕</button>
          </div>
        </td></tr>
      )}
      {executingArb && (
        <tr><td colSpan={12}>
          <ExecuteArbModal arb={executingArb} onClose={() => setExecutingArb(null)} />
        </td></tr>
      )}
    </tbody>
    {profitableOutcomes.length > 0 && (
      <tfoot className="bg-[#17212B] border-t-2 border-[#5DBE81]/30">
        <tr>
          <td colSpan={7} className="px-4 py-3">
            <span className="text-[10px] uppercase tracking-wider text-[#8A9BA8] font-medium">
              Accumulated Arb Profit
            </span>
            <span className="ml-2 text-[10px] text-[#8A9BA8]">
              ({profitableOutcomes.length} opportun{profitableOutcomes.length > 1 ? "ities" : "y"})
            </span>
          </td>
          <td colSpan={5} className="px-4 py-3 text-right">
            <div className="group inline-block">
              <span className="text-lg font-bold text-[#5DBE81]">
                {formatCurrency(accumulatedProfit)}
              </span>
              <span className="ml-2 text-[10px] text-[#8A9BA8]">after fees</span>
              {hasFeeBreakdown && (accumulatedKalshiFees > 0 || accumulatedPmFees > 0) && (
                <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-72 bg-[#17212B] border border-[#232E3C] rounded-lg shadow-xl p-3 text-xs">
                  <div className="font-bold text-[#FFFFFF] mb-2">Accumulated Fee Breakdown</div>
                  <div className="space-y-1 mb-2">
                    <div className="flex justify-between text-[#8A9BA8]">
                      <span>Gross profit (before fees)</span>
                      <span className="text-[#FFFFFF]">{formatCurrency(accumulatedGrossProfit)}</span>
                    </div>
                    <div className="flex justify-between text-[#8A9BA8]">
                      <span>Kalshi fees total</span>
                      <span className="text-[#ef4444]">-{formatCurrency(accumulatedKalshiFees)}</span>
                    </div>
                    <div className="flex justify-between text-[#8A9BA8]">
                      <span>Polymarket fees total</span>
                      <span className="text-[#ef4444]">-{formatCurrency(accumulatedPmFees)}</span>
                    </div>
                  </div>
                  <div className="flex justify-between text-[#FFFFFF] font-medium border-t border-[#182533] pt-2">
                    <span>Net profit (after fees)</span>
                    <span className="text-[#5DBE81] font-bold">{formatCurrency(accumulatedProfit)}</span>
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      </tfoot>
    )}
    </>
  );
}

// PERF-P0: memoized export — skip re-render when props are shallow-equal
export const OutcomeTableBody = React.memo(OutcomeTableBodyInner);
