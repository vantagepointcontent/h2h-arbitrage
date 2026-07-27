"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, TrendingUp, Zap } from "lucide-react";
import { parseArbLegs, LegBreakdown, ArbTypeBadge } from "./ArbLegBreakdown";
import { ExecuteArbModal, buildExecutableArb, type ExecutableArb } from "./ExecuteArbModal";
import { ProfitDistributionPanel } from "./ProfitDistributionPanel";
import { computeApy } from "@/lib/matcher";
import type { ProfitDistribution } from "@/lib/profit-distribution";
import { ArbDecayCurve } from "./ArbDecayCurve";
import { ShareStakeCalculator } from "./ShareStakeCalculator";
import {
  ARB_ALERTS_STORAGE_KEY,
  type ArbAlert,
  isAlertThresholdHit,
  makeArbAlertKey,
  parseArbAlerts,
  serializeArbAlerts,
} from "@/lib/arb-alerts";

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
  marketId?: string;
  formatCurrency: (n: number) => string;
  marketExpiryDate?: string | null;
  category?: string;
  /** Market title — when provided, Execute buttons render for simple 2-leg arbs */
  marketTitle?: string;
}

/**
 * UI-16: Arb Opportunities — always-visible section below the outcomes table.
 *
 * Shows ONLY positive-arb rows with full leg mapping (no expanding needed).
 * Each row shows strategy type badge, leg breakdown (with fees + net profit), ROI, profit, APY.
 * Execute button renders when marketTitle + ticker + conditionId are available.
 * Distinct from the outcomes table which shows ALL outcomes (including non-arb).
 */
export function ArbOpportunitiesPanel({ outcomes, marketId, formatCurrency, marketExpiryDate, category, marketTitle }: Props) {
  const [executingArb, setExecutingArb] = useState<ExecutableArb | null>(null);
  const [resolvingArtist, setResolvingArtist] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [distributions, setDistributions] = useState<Record<string, ProfitDistribution>>({});
  const [alerts, setAlerts] = useState<Record<string, ArbAlert>>(() =>
    typeof window === "undefined" ? {} : parseArbAlerts(localStorage.getItem(ARB_ALERTS_STORAGE_KEY)),
  );
  const [alertDrafts, setAlertDrafts] = useState<Record<string, string>>({});
  const [flashingAlerts, setFlashingAlerts] = useState<Set<string>>(new Set());
  const previouslyHitAlerts = useRef(new Set<string>());

  useEffect(() => {
    localStorage.setItem(ARB_ALERTS_STORAGE_KEY, serializeArbAlerts(alerts));
  }, [alerts]);

  const saveAlert = (key: string) => {
    const targetRoiPct = Number(alertDrafts[key]);
    if (!Number.isFinite(targetRoiPct) || targetRoiPct <= 0) return;
    setAlerts(current => ({ ...current, [key]: { key, targetRoiPct } }));
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  };

  const clearAlert = (key: string) => {
    setAlerts(current => {
      const { [key]: _removed, ...remaining } = current;
      return remaining;
    });
    previouslyHitAlerts.current.delete(key);
    setFlashingAlerts(current => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  const arbOpps = useMemo(() => {
    return outcomes
      .filter(o => o.arbitrage.expectedProfit > 0 && o.arbitrage.roiPct > 0)
      .sort((a, b) => b.arbitrage.roiPct - a.arbitrage.roiPct);
  }, [outcomes]);

  useEffect(() => {
    const activeKeys = new Set<string>();
    for (const opportunity of arbOpps) {
      const key = makeArbAlertKey({
        artist: opportunity.artist,
        strategy: opportunity.arbitrage.strategy,
        kalshiTicker: opportunity.kalshi?.ticker,
        pmConditionId: opportunity.polymarket?.conditionId,
      });
      const hit = isAlertThresholdHit(opportunity.arbitrage.roiPct, alerts[key]);
      if (!hit) {
        previouslyHitAlerts.current.delete(key);
        continue;
      }
      activeKeys.add(key);
      if (previouslyHitAlerts.current.has(key)) continue;

      previouslyHitAlerts.current.add(key);
      setFlashingAlerts(current => new Set(current).add(key));
      window.setTimeout(() => setFlashingAlerts(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      }), 1600);
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("EdgeFinder target reached", {
          body: `${opportunity.artist}: ${opportunity.arbitrage.roiPct.toFixed(2)}% net ROI reached your ${alerts[key].targetRoiPct.toFixed(2)}% target.`,
        });
      }
    }
    for (const key of previouslyHitAlerts.current) {
      if (!activeKeys.has(key)) previouslyHitAlerts.current.delete(key);
    }
  }, [alerts, arbOpps]);

  const startExecute = async (o: Outcome, distribution?: ProfitDistribution) => {
    const adjustedKalshiStake = distribution?.kalshiStake ?? o.arbitrage.kalshiStake ?? 0;
    const adjustedPmStake = distribution?.pmStake ?? o.arbitrage.pmStake ?? 0;
    const adjustedProfit = distribution?.worstCaseNetProfit ?? o.arbitrage.expectedProfit;
    const adjustedRoi = adjustedKalshiStake + adjustedPmStake > 0
      ? (adjustedProfit / (adjustedKalshiStake + adjustedPmStake)) * 100
      : o.arbitrage.roiPct;
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
        roiPct: adjustedRoi,
        expectedProfit: adjustedProfit,
        kalshiStake: adjustedKalshiStake,
        pmStake: adjustedPmStake,
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
      }, marketTitle);
      if (!exec) {
        // Provide specific reason why it's not executable
        const kStake = adjustedKalshiStake;
        const pmStake = adjustedPmStake;
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
            o.arbitrage.fees,
            o.arbitrage.expectedProfit,
          );
          const apy = o.arbitrage.apyPct ?? computeApy(o.arbitrage.roiPct, marketExpiryDate);

          const distributionKey = `${idx}-${o.artist}`;
          const adjusted = distributions[distributionKey];
          // The execution engine only supports equal contract counts across both
          // legs. A non-centre split intentionally creates directional exposure,
          // so it must remain manual-only rather than silently clipping the two
          // orders back to the smaller shared contract count.
          const isDirectionalSplit = adjusted != null && adjusted.splitPct !== 50;
          const canExecute = marketTitle && o.arbitrage.roiPct > 0 && !(o.arbitrage as any).suspicious
            && o.kalshi?.ticker && o.polymarket?.conditionId
            && !isDirectionalSplit
            && (!adjusted || (adjusted.kalshiStake > 0 && adjusted.pmStake > 0));
          const displayProfit = adjusted?.worstCaseNetProfit ?? o.arbitrage.expectedProfit;
          const displayRoi = adjusted
            ? (displayProfit / adjusted.totalStake) * 100
            : o.arbitrage.roiPct;
          const alertKey = makeArbAlertKey({
            artist: o.artist,
            strategy: o.arbitrage.strategy,
            kalshiTicker: o.kalshi?.ticker,
            pmConditionId: o.polymarket?.conditionId,
          });
          const activeAlert = alerts[alertKey];
          const alertHit = isAlertThresholdHit(displayRoi, activeAlert);
          const kalshiPrice = o.arbitrage.strategy === 'Buy YES Kalshi + NO PM'
            ? o.kalshi?.yesAsk : o.kalshi?.noAsk;
          const pmPrice = o.arbitrage.strategy === 'Buy YES Kalshi + NO PM'
            ? o.polymarket?.noPrice : o.polymarket?.yesPrice;
          const supportsDistribution = !breakdown.isCross
            && (o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' || o.arbitrage.strategy === 'Buy YES PM + NO Kalshi')
            && kalshiPrice != null && kalshiPrice > 0 && kalshiPrice < 1
            && pmPrice != null && pmPrice > 0 && pmPrice < 1
            && (o.arbitrage.kalshiStake ?? 0) + (o.arbitrage.pmStake ?? 0) > 0;

          return (
            <div key={`${idx}-${o.artist}`} className={`px-4 py-3 hover:bg-[#0E1621] transition-colors ${flashingAlerts.has(alertKey) ? "bg-[#5DBE81]/20 animate-pulse" : alertHit ? "bg-[#5DBE81]/10" : ""}`}>
              {/* Row 1: badge + concise strategy + ROI + profit + APY + execute */}
              <div className="flex items-center gap-3 flex-wrap">
                <ArbTypeBadge strategy={o.arbitrage.strategy} arbType={(o.arbitrage as any).arbType} />
                {marketId && <ArbDecayCurve marketId={marketId} outcome={o.artist} compact />}
                <div className="flex-1" />
                <span className="text-xs font-bold text-[#5DBE81]" title="ROI (net of fees)">
                  {displayRoi.toFixed(2)}%
                </span>
                <span className="text-xs text-[#5DBE81]" title="Expected profit (net of fees)">
                  {formatCurrency(displayProfit)}
                </span>
                {apy > 0 && (
                  <span className="text-[10px] text-[#8A9BA8]" title="Annualized ROI">
                    APY {apy.toFixed(0)}%
                  </span>
                )}
                {activeAlert && (
                  <span className={`inline-flex items-center gap-1 text-[10px] ${alertHit ? "text-[#5DBE81]" : "text-[#facc15]"}`} title={`Alert at ${activeAlert.targetRoiPct.toFixed(2)}% net ROI`}>
                    <Bell className="w-3 h-3" /> {activeAlert.targetRoiPct.toFixed(2)}%
                  </span>
                )}
                {canExecute && (
                  <span className="flex flex-col items-center">
                    <span className="text-[8px] uppercase tracking-wider text-[#8A9BA8] mb-0.5">Action</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); startExecute(o, adjusted); }}
                      disabled={resolvingArtist === o.artist}
                      className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-[#facc15]/20 text-[#facc15] hover:bg-[#facc15]/40 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                      title="Manually execute this arb (opens confirmation)"
                    >
                      <Zap className="w-2.5 h-2.5" /> {resolvingArtist === o.artist ? "..." : "Execute"}
                    </button>
                  </span>
                )}
              </div>

              {/* Row 2: leg breakdown (always visible, no expanding) */}
              {breakdown.legs.length > 0 && (
                <div className="mt-2">
                  <LegBreakdown breakdown={breakdown} formatCurrency={formatCurrency} />
                </div>
              )}
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                {activeAlert ? (
                  <button
                    onClick={() => clearAlert(alertKey)}
                    className="px-2 py-1 rounded text-[10px] font-medium border border-[#facc15]/30 text-[#facc15] hover:bg-[#facc15]/10 transition-colors"
                    title="Clear this in-app alert"
                  >
                    Clear alert
                  </button>
                ) : (
                  <>
                    <label className="text-[10px] text-[#8A9BA8]" htmlFor={`alert-${idx}`}>Target net ROI %</label>
                    <input
                      id={`alert-${idx}`}
                      type="number"
                      min="0.01"
                      step="0.01"
                      inputMode="decimal"
                      value={alertDrafts[alertKey] ?? ""}
                      onChange={(event) => setAlertDrafts(current => ({ ...current, [alertKey]: event.target.value }))}
                      placeholder="3.00"
                      className="w-20 rounded border border-[#232E3C] bg-[#0E1621] px-2 py-1 text-[10px] text-[#FFFFFF] placeholder:text-[#48555F] focus:border-[#5DBE81]/50 outline-none"
                    />
                    <button
                      onClick={() => saveAlert(alertKey)}
                      disabled={!Number.isFinite(Number(alertDrafts[alertKey])) || Number(alertDrafts[alertKey]) <= 0}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border border-[#5DBE81]/30 text-[#5DBE81] hover:bg-[#5DBE81]/10 transition-colors disabled:opacity-40"
                      title="Set an in-app alert for this net ROI threshold"
                    >
                      <Bell className="w-3 h-3" /> Set Alert
                    </button>
                  </>
                )}
              </div>
              {(o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' || o.arbitrage.strategy === 'Buy YES PM + NO Kalshi')
                && kalshiPrice != null && pmPrice != null && (
                <ShareStakeCalculator
                  strategy={o.arbitrage.strategy}
                  kalshiYesAsk={o.kalshi?.yesAsk ?? 0}
                  kalshiNoAsk={o.kalshi?.noAsk ?? 0}
                  pmYesAsk={o.polymarket?.yesPrice ?? 0}
                  pmNoAsk={o.polymarket?.noPrice ?? 0}
                  kalshiAskDepth={o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' ? o.kalshi?.yesAskDepth : o.kalshi?.noAskDepth}
                  pmAskDepth={o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' ? o.polymarket?.noAskDepth : o.polymarket?.askDepth}
                  category={category}
                  formatCurrency={formatCurrency}
                />
              )}
              {supportsDistribution && (
                <ProfitDistributionPanel
                  strategy={o.arbitrage.strategy as 'Buy YES Kalshi + NO PM' | 'Buy YES PM + NO Kalshi'}
                  kalshiPrice={kalshiPrice}
                  pmPrice={pmPrice}
                  kalshiStake={o.arbitrage.kalshiStake ?? 0}
                  pmStake={o.arbitrage.pmStake ?? 0}
                  category={category}
                  kalshiWinLabel={o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' ? 'Kalshi YES' : 'Kalshi NO'}
                  pmWinLabel={o.arbitrage.strategy === 'Buy YES Kalshi + NO PM' ? 'Polymarket NO' : 'Polymarket YES'}
                  formatCurrency={formatCurrency}
                  onChange={(distribution) => setDistributions(previous => ({ ...previous, [distributionKey]: distribution }))}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Execute error */}
      {execError && (
        <div className="mx-4 my-2 rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 px-4 py-2.5 text-xs text-[#ef4444] flex items-center gap-2">
          <span className="text-sm">⚠️</span>
          <span>{execError}</span>
          <button onClick={() => setExecError(null)} className="ml-auto text-[#ef4444]/60 hover:text-[#ef4444] text-xs">✕</button>
        </div>
      )}

      {/* Execute confirmation modal */}
      {executingArb && (
        <ExecuteArbModal arb={executingArb} onClose={() => setExecutingArb(null)} />
      )}
    </div>
  );
}