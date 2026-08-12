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
import { formatPrice } from "@/app/lib/page-shared";
import { MarketDepthCharts } from './MarketDepthCharts';
import { calculateShareRatio } from '@/lib/share-ratio';
import { ProfitDistributionPanel } from './ProfitDistributionPanel';
import { resolveDistributionStakes, type ProfitDistribution } from '@/lib/profit-distribution';

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
    maxCapital?: number;
    strategy: string;
    /** True only when every leg has a verified positive ask depth. */
    depthVerified?: boolean;
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
  /** UI-06/UI-08: sort field for the outcome table */
  sortField?: "roi" | "apy" | "profit" | "spread";
  /** UI-06: sort direction for the outcome table */
  sortDir?: "asc" | "desc";
  /** UI-15: market expiry date for APY tooltip breakdown */
  marketExpiryDate?: string | null;
  /** UI-11: ISO timestamp of the last scan, passed to execution for timeline */
  scanTime?: string;
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
  scanTime: scanTimeProp,
}: OutcomeTableBodyProps) {
  const sourceOutcomes: unknown[] = Array.isArray(outcomes) ? outcomes : [];
  const safeOutcomes = sourceOutcomes.filter((outcome): outcome is Outcome => {
    if (!outcome || typeof outcome !== 'object') return false;
    const candidate = outcome as Partial<Outcome>;
    return typeof candidate.artist === 'string'
      && candidate.artist.trim().length > 0
      && !!candidate.arbitrage
      && typeof candidate.arbitrage === 'object'
      && typeof candidate.arbitrage.strategy === 'string';
  });
  const hasMalformedOutcomes = !Array.isArray(outcomes) || safeOutcomes.length !== sourceOutcomes.length;

  // EXEC-002: manual-execute state — modal + per-row token resolution
  const [executingArb, setExecutingArb] = useState<ExecutableArb | null>(null);
  const [resolvingArtist, setResolvingArtist] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  // Sparkline expand state — which artist's chart is expanded (independent of row expand)
  const [expandedChartArtist, setExpandedChartArtist] = useState<string | null>(null);

  // Slider-adjusted stakes are scoped to an outcome and are passed to manual execution.
  const [profitDistributions, setProfitDistributions] = useState<Record<string, ProfitDistribution>>({});

  const startExecute = async (o: Outcome, distribution?: ProfitDistribution) => {
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
    const executionArb = distribution
      ? { ...o.arbitrage, kalshiStake: distribution.kalshiStake, pmStake: distribution.pmStake }
      : o.arbitrage;
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
        roiPct: executionArb.roiPct,
        expectedProfit: executionArb.expectedProfit,
        kalshiStake: executionArb.kalshiStake ?? 0,
        pmStake: executionArb.pmStake ?? 0,
        kalshiYesAsk: o.kalshi.yesAsk ?? null,
        kalshiNoAsk: o.kalshi.noAsk ?? null,
        kalshiYesAskShares: Number(o.kalshi.yesAskDepth),
        kalshiNoAskShares: Number(o.kalshi.noAskDepth),
        pmYesAsk: o.polymarket.yesPrice ?? null,
        pmNoAsk: o.polymarket.noPrice ?? null,
        pmYesAskShares: o.polymarket.askDepth,
        pmNoAskShares: o.polymarket.noAskDepth,
        kalshiTicker: o.kalshi.ticker,
        pmYesTokenId: data.yesTokenId,
        pmNoTokenId: data.noTokenId,
        scanTime: scanTimeProp,
        depthVerified: o.arbitrage.depthVerified,
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
        } else {
          reason = 'Live ask-depth is unavailable or stale for one of the two legs. Refresh the market and try again.';
        }
        throw new Error(reason);
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
        // UI-08: quoted cross-platform price difference, signed PM YES − Kalshi YES.
        // Positive values rank first; fee-aware ROI remains the profitability signal.
        const spread = (outcome: Outcome) => ((outcome.polymarket?.yesPrice ?? 0) - (outcome.kalshi?.yesAsk ?? 0)) * 100;
        const va = sortField === "roi" ? a.arbitrage.roiPct : sortField === "apy" ? (a.arbitrage.apyPct ?? 0) : sortField === "profit" ? a.arbitrage.expectedProfit : spread(a);
        const vb = sortField === "roi" ? b.arbitrage.roiPct : sortField === "apy" ? (b.arbitrage.apyPct ?? 0) : sortField === "profit" ? b.arbitrage.expectedProfit : spread(b);
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
    <tbody className="divide-y divide-[var(--border-subtle)] tabular-nums">
      {hasMalformedOutcomes && (
        <tr>
          <td colSpan={12} role="alert" className="px-4 py-3 text-xs text-[var(--status-warning)]">
            Market outcome details are unavailable for one or more stale records. Valid rows remain usable; refresh prices to retry the missing data.
          </td>
        </tr>
      )}
      {displayOutcomes.map((o, idx) => {
        const k = o.kalshi;
        const p = o.polymarket;
        const hasPrices = !!(k && p && k.yesAsk != null && p.yesPrice != null);
        const profit = hasPrices ? o.arbitrage.expectedProfit : 0;
        const roiColor = !hasPrices ? "text-[var(--text-secondary)]" : o.arbitrage.roiPct > 0 ? "text-[var(--status-positive)]" : o.arbitrage.roiPct < 0 ? "text-[var(--status-negative)]" : "text-[var(--text-secondary)]";
        // APY color: gray for non-actionable (no prices, ROI <= 0, or APY <= 0); green only when ROI is positive and APY is positive
        const apyColor = !hasPrices || o.arbitrage.roiPct <= 0 || (o.arbitrage.apyPct ?? 0) <= 0 ? "text-[var(--text-secondary)]" : "text-[var(--status-positive)]";
        const isExpanded = expandedArtist === o.artist;
        const totalStake = (o.arbitrage.kalshiStake ?? 0) + (o.arbitrage.pmStake ?? 0);
        const stakeRatio = totalStake > 0
          ? Math.max(o.arbitrage.kalshiStake ?? 0, o.arbitrage.pmStake ?? 0) / Math.min(o.arbitrage.kalshiStake ?? 0, o.arbitrage.pmStake ?? 0)
          : 1;
        const isBalanced = totalStake > 0 && stakeRatio <= 1.25;

        return (
          <React.Fragment key={`${idx}-${o.artist}`}>
            <tr
              className={`hover:bg-[var(--surface-hover)]/50 transition-colors cursor-pointer ${isExpanded ? "bg-[var(--surface-hover)]/30" : ""}`}
              onClick={() => setExpandedArtist(isExpanded ? null : o.artist)}
            >
              <td data-testid="outcome-name-cell" className="sticky left-0 z-10 bg-[var(--surface-panel)] px-4 py-3 font-medium text-[var(--text-primary)]">
                <div className="flex items-center gap-1.5" title={buildMarketTooltip({ eventTitle: marketTitle ?? o.artist, expiryDate: marketExpiryDate })}>
                  <span className={`transition-transform text-[var(--text-secondary)] ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                  {o.artist}
                </div>
              </td>
              <td className="px-4 py-3 text-right text-[var(--text-primary)]">
                {formatPrice(o.kalshi?.yesAsk)}
                {priceChanges?.get(o.artist) === "up" && <span className="ml-1 animate-pulse text-[var(--status-positive)]">▲</span>}
                {priceChanges?.get(o.artist) === "down" && <span className="ml-1 animate-pulse text-[var(--status-negative)]">▼</span>}
              </td>
              <td className="px-4 py-3 text-right text-[var(--text-secondary)]">{formatPrice(o.kalshi?.noAsk)}</td>
              <td className="px-4 py-3 text-right text-[var(--text-primary)]">
                {formatPrice(o.polymarket?.yesPrice)}
                {priceChanges?.get(o.artist) === "up" && <span className="ml-1 animate-pulse text-[var(--status-positive)]">▲</span>}
                {priceChanges?.get(o.artist) === "down" && <span className="ml-1 animate-pulse text-[var(--status-negative)]">▼</span>}
              </td>
              <td className="px-4 py-3 text-right text-[var(--text-secondary)]">{formatPrice(o.polymarket?.noPrice)}</td>
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
                  <span className="text-[var(--text-secondary)]">—</span>
                ) : profit > 0 ? (
                  <div className="group inline-block">
                    <span className="text-[var(--text-primary)] cursor-help">{formatCurrency(profit)}</span>
                    {o.arbitrage.fees && (
                      <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-72 bg-[var(--surface-panel)] border border-[var(--border-strong)] rounded-lg shadow-xl p-3 text-xs">
                        <div className="font-bold text-[var(--text-primary)] mb-2">Fee Breakdown</div>
                        <div className="space-y-1 mb-2">
                          <div className="flex justify-between text-[var(--text-secondary)]">
                            <span>Gross profit</span>
                            <span className="text-[var(--text-primary)]">{formatCurrency(profit + o.arbitrage.fees.kalshiFee + o.arbitrage.fees.pmFee)}</span>
                          </div>
                          <div className="flex justify-between text-[var(--text-secondary)]">
                            <span>Kalshi fee</span>
                            <span className="text-[var(--status-negative)]">-{formatCurrency(o.arbitrage.fees.kalshiFee)}</span>
                          </div>
                          <div className="flex justify-between text-[var(--text-secondary)]">
                            <span>Polymarket fee</span>
                            <span className="text-[var(--status-negative)]">-{formatCurrency(o.arbitrage.fees.pmFee)}</span>
                          </div>
                        </div>
                        <div className="flex justify-between text-[var(--text-primary)] font-medium border-t border-[var(--border-subtle)] pt-2">
                          <span>Net profit (after fees)</span>
                          <span className="text-[var(--status-positive)] font-bold">{formatCurrency(profit)}</span>
                        </div>
                        <div className="border-t border-[var(--border-subtle)] pt-2 mt-2 space-y-1">
                          <div className="text-[var(--text-secondary)] text-[10px]">{o.arbitrage.fees.kalshiFeeDetails}</div>
                          <div className="text-[var(--text-secondary)] text-[10px]">{o.arbitrage.fees.pmFeeDetails}</div>
                          <div className="flex justify-between text-[var(--text-primary)] font-medium border-t border-[var(--border-subtle)] pt-1">
                            <span>Worst-case net</span>
                            <span className={o.arbitrage.fees.worstCaseNetProfit >= 0 ? "text-[var(--status-positive)]" : "text-[var(--status-negative)]"}>{formatCurrency(o.arbitrage.fees.worstCaseNetProfit)}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : "—"}
              </td>
              <td className="px-4 py-3 text-right">
                {(() => {
                  if (!hasPrices || !k || !p) return <span className="text-[var(--text-secondary)]">—</span>;
                  // UI-10: Hide stake/depth for negative-arb rows — no point showing
                  // deployable capital when there's no profitable arb.
                  if (o.arbitrage.depthVerified === false) {
                    return <span className="text-[var(--status-warning)] text-xs" title="Live ask depth is missing for one or more required legs. This quote is not executable.">Depth unknown</span>;
                  }
                  if (o.arbitrage.roiPct <= 0) return <span className="text-[var(--text-secondary)]">—</span>;
                  const liq = computeLiquidityFromOutcome(k, p, o.arbitrage);
                  if (!liq) return <span className="text-[var(--text-secondary)]">—</span>;
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
                        <span className={`text-[10px] font-medium ${isBalanced ? "text-[var(--status-positive)]" : "text-[var(--status-negative)]"}`} title="Total stake (Kalshi + Polymarket)">
                          <span className="text-[var(--text-secondary)]">Stake:</span> {formatCurrency(totalStake)}
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
                }} isExpanded={expandedChartArtist === o.artist} /> : <span className="text-[var(--text-secondary)] text-xs">—</span>}
              </td>
              <td className="px-4 py-3 text-right">
                {marketId && o.arbitrage.roiPct > 0 ? <ArbDecayCurve marketId={marketId} outcome={o.artist} /> : <span className="text-[var(--text-secondary)] text-xs">—</span>}
              </td>
              <td className="px-4 py-3 text-xs">
                {!hasPrices ? (
                  <span className="text-[var(--text-secondary)]">—</span>
                ) : (() => {
                  if (o.arbitrage.strategy === 'No arb') {
                    return <span className="text-[var(--text-secondary)]">No arb</span>;
                  }
                  return (
                    <span className="inline-flex items-center gap-1.5">
                      <ArbTypeBadge strategy={o.arbitrage.strategy} arbType={(o.arbitrage as any).arbType} onClick={() => setExpandedArtist(expandedArtist === o.artist ? null : o.artist)} />
                      {/* EXEC-002: manual execute — only for simple 2-leg positive arbs */}
                      {marketTitle && o.arbitrage.roiPct > 0 && o.arbitrage.depthVerified !== false && !(o.arbitrage as any).suspicious && o.kalshi?.ticker && o.polymarket?.conditionId && (
                        <span className="flex flex-col items-center">
                          <span className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mb-0.5">Action</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); startExecute(o, profitDistributions[o.artist]); }}
                            disabled={resolvingArtist === o.artist}
                            className="px-1.5 py-0.5 rounded text-xs font-bold uppercase tracking-wide bg-[var(--status-warning)]/20 text-[var(--status-warning)] hover:bg-[var(--status-warning)]/40 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
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
              <tr className="bg-[var(--surface-panel)]/50">
                <td colSpan={12} className="px-4 py-3">
                  <div className="flex items-center gap-6 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--text-secondary)]">Total Stake:</span>
                      <span className="font-bold text-[var(--text-primary)]">{formatCurrency(totalStake)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--text-secondary)]">Breakdown:</span>
                      <span className="text-[var(--status-positive)]">Kalshi: {formatCurrency(o.arbitrage.kalshiStake ?? 0)}</span>
                      <span className="text-[var(--text-secondary)]">|</span>
                      <span className="text-[var(--status-negative)]">Polymarket: {formatCurrency(o.arbitrage.pmStake ?? 0)}</span>
                    </div>
                    <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${isBalanced ? "bg-[var(--status-positive)]/10 text-[var(--status-positive)]" : "bg-[var(--status-negative)]/10 text-[var(--status-negative)]"}`}>
                      {isBalanced ? "● Balanced" : "● Imbalanced"}
                    </div>
                    {/* APY in expanded detail — same value as scan table column */}
                    {hasPrices && o.arbitrage.apyPct != null && o.arbitrage.apyPct > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[var(--text-secondary)]">APY:</span>
                        <ApyValueTooltip apy={o.arbitrage.apyPct} roi={o.arbitrage.roiPct} daysToExpiry={getDaysToExpiry(marketExpiryDate)}>
                          <span className="font-bold text-[var(--status-positive)]">{formatPercent(o.arbitrage.apyPct)}</span>
                        </ApyValueTooltip>
                      </div>
                    )}
                    {/* Days to expiry in expanded detail */}
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--text-secondary)]">Days to expiry:</span>
                      <span className={`font-medium ${formatTimeToExpiry(marketExpiryDate) === "Expired" ? "text-[var(--status-negative)]" : "text-[var(--text-primary)]"}`}>
                        {formatTimeToExpiry(marketExpiryDate)}
                      </span>
                    </div>
                  </div>
                  {/* UI-13: Fee breakdown in expanded row */}
                  {o.arbitrage.fees && (
                    <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
                      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] font-medium mb-2">Fee Breakdown</div>
                      <div className="flex items-center gap-6 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-[var(--text-secondary)]">Gross:</span>
                          <span className="text-[var(--text-primary)] font-medium">{formatCurrency(profit + o.arbitrage.fees.kalshiFee + o.arbitrage.fees.pmFee)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[var(--text-secondary)]">Kalshi fee:</span>
                          <span className="text-[var(--status-negative)]">-{formatCurrency(o.arbitrage.fees.kalshiFee)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[var(--text-secondary)]">PM fee:</span>
                          <span className="text-[var(--status-negative)]">-{formatCurrency(o.arbitrage.fees.pmFee)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[var(--text-secondary)]">Net:</span>
                          <span className="text-[var(--status-positive)] font-bold">{formatCurrency(profit)}</span>
                        </div>
                      </div>
                      <div className="mt-1.5 text-[10px] text-[var(--text-secondary)] space-y-0.5">
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
                    const kalshiLeg = breakdown.legs.find(leg => leg.platform === 'Kalshi');
                    const polymarketLeg = breakdown.legs.find(leg => leg.platform === 'Polymarket');
                    const ratio = calculateShareRatio(
                      kalshiLeg?.stake,
                      kalshiLeg?.price,
                      polymarketLeg?.stake,
                      polymarketLeg?.price,
                    );
                    const supportsDistribution = o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' || o.arbitrage.strategy === 'Buy YES PM + NO Kalshi';
                    const kalshiPrice = o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' ? o.kalshi?.yesAsk : o.kalshi?.noAsk;
                    const pmPrice = o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' ? o.polymarket?.noPrice : o.polymarket?.yesPrice;
                    const distributionStakes = supportsDistribution
                      && kalshiPrice != null && kalshiPrice > 0 && kalshiPrice < 1
                      && pmPrice != null && pmPrice > 0 && pmPrice < 1
                      ? resolveDistributionStakes({
                          kalshiStake: o.arbitrage.kalshiStake,
                          pmStake: o.arbitrage.pmStake,
                          maxCapital: o.arbitrage.maxCapital,
                          expectedProfit: o.arbitrage.expectedProfit,
                          roiPct: o.arbitrage.roiPct,
                          kalshiPrice,
                          pmPrice,
                        })
                      : null;
                    return <>
                      <LegBreakdown breakdown={breakdown} formatCurrency={formatCurrency} />
                      {distributionStakes && kalshiPrice != null && pmPrice != null && <ProfitDistributionPanel
                        strategy={(o.arbitrage.strategy as 'Buy YES Kalshi + NO PM' | 'Buy YES PM + NO Kalshi')}
                        kalshiPrice={kalshiPrice}
                        pmPrice={pmPrice}
                        kalshiStake={distributionStakes.kalshiStake}
                        pmStake={distributionStakes.pmStake}
                        kalshiWinLabel={o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' ? 'Kalshi YES' : 'Kalshi NO'}
                        pmWinLabel={o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' ? 'Polymarket NO' : 'Polymarket YES'}
                        formatCurrency={formatCurrency}
                        onChange={(distribution) => setProfitDistributions(previous => ({ ...previous, [o.artist]: distribution }))}
                      />}
                      {supportsDistribution && !distributionStakes && (
                        <div role="status" className="mt-3 rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 px-3 py-2 text-xs text-[var(--status-warning)]">
                          Stake sizing is unavailable for this cached market. Refresh prices to load executable sizing; the remaining market details are still available.
                        </div>
                      )}
                      {ratio && <div className="mt-2 flex items-center justify-between rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-3 py-2 text-xs">
                        <span className="uppercase tracking-wider text-[var(--text-secondary)]">Hedge share ratio</span>
                        <span className="font-mono font-bold text-[var(--text-primary)]">PM {ratio.display.split(':')[0]} : {ratio.display.split(':')[1]} Kalshi</span>
                      </div>}
                    </>;
                  })()}

                  <ExecutionReadiness
                    kalshi={o.kalshi}
                    polymarket={o.polymarket}
                    arbitrage={o.arbitrage}
                    formatCurrency={formatCurrency}
                  />

                  <MarketDepthCharts
                    kalshiTicker={o.kalshi?.ticker}
                    pmConditionId={o.polymarket?.conditionId}
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
          <div className="my-2 rounded-lg border border-[var(--status-negative)]/30 bg-[var(--status-negative)]/10 px-4 py-2.5 text-xs text-[var(--status-negative)] flex items-center gap-2">
            <span className="text-sm">⚠️</span>
            <span>{execError}</span>
            <button onClick={() => setExecError(null)} className="ml-auto text-[var(--status-negative)]/60 hover:text-[var(--status-negative)] text-xs">✕</button>
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
      <tfoot className="bg-[var(--surface-panel)] border-t-2 border-[var(--status-positive)]/30">
        <tr>
          <td colSpan={7} className="px-4 py-3">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] font-medium">
              Accumulated Arb Profit
            </span>
            <span className="ml-2 text-[10px] text-[var(--text-secondary)]">
              ({profitableOutcomes.length} opportun{profitableOutcomes.length > 1 ? "ities" : "y"})
            </span>
          </td>
          <td colSpan={5} className="px-4 py-3 text-right">
            <div className="group inline-block">
              <span className="text-lg font-bold text-[var(--status-positive)]">
                {formatCurrency(accumulatedProfit)}
              </span>
              <span className="ml-2 text-[10px] text-[var(--text-secondary)]">after fees</span>
              {hasFeeBreakdown && (accumulatedKalshiFees > 0 || accumulatedPmFees > 0) && (
                <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-72 bg-[var(--surface-panel)] border border-[var(--border-strong)] rounded-lg shadow-xl p-3 text-xs">
                  <div className="font-bold text-[var(--text-primary)] mb-2">Accumulated Fee Breakdown</div>
                  <div className="space-y-1 mb-2">
                    <div className="flex justify-between text-[var(--text-secondary)]">
                      <span>Gross profit (before fees)</span>
                      <span className="text-[var(--text-primary)]">{formatCurrency(accumulatedGrossProfit)}</span>
                    </div>
                    <div className="flex justify-between text-[var(--text-secondary)]">
                      <span>Kalshi fees total</span>
                      <span className="text-[var(--status-negative)]">-{formatCurrency(accumulatedKalshiFees)}</span>
                    </div>
                    <div className="flex justify-between text-[var(--text-secondary)]">
                      <span>Polymarket fees total</span>
                      <span className="text-[var(--status-negative)]">-{formatCurrency(accumulatedPmFees)}</span>
                    </div>
                  </div>
                  <div className="flex justify-between text-[var(--text-primary)] font-medium border-t border-[var(--border-subtle)] pt-2">
                    <span>Net profit (after fees)</span>
                    <span className="text-[var(--status-positive)] font-bold">{formatCurrency(accumulatedProfit)}</span>
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
