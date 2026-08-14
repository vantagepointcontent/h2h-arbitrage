"use client";

import { useMemo, useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { calculateProfitDistribution, type ProfitDistribution } from "@/lib/profit-distribution";

interface Props {
  strategy: 'Buy YES Kalshi + NO PM' | 'Buy YES PM + NO Kalshi';
  kalshiPrice: number;
  pmPrice: number;
  kalshiStake: number;
  pmStake: number;
  category?: string;
  kalshiWinLabel: string;
  pmWinLabel: string;
  formatCurrency: (value: number) => string;
  onChange: (distribution: ProfitDistribution) => void;
}

/**
 * Read-only settlement view for the canonical one-share hedge.
 */
export function ProfitDistributionPanel({
  strategy, kalshiPrice, pmPrice, kalshiStake, pmStake, category, kalshiWinLabel, pmWinLabel, formatCurrency, onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const splitPct = 50;
  void onChange;
  const distribution = useMemo(() => calculateProfitDistribution({
    strategy, kalshiPrice, pmPrice, kalshiStake, pmStake, category, splitPct,
  }), [strategy, kalshiPrice, pmPrice, kalshiStake, pmStake, category, splitPct]);


  return (
    <div className="mt-3 rounded-lg border border-[#3A4858] bg-[#121E2B] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-[#182533] transition-colors"
      >
        <SlidersHorizontal className="w-3.5 h-3.5 text-[#facc15]" />
        <span className="text-[11px] font-bold uppercase tracking-wide text-[#FFFFFF]">Profit Distribution</span>
        <span className="text-[10px] text-[#8A9BA8]">{splitPct === 50 ? 'Balanced' : `${splitPct}% Kalshi payout bias`}</span>
        <ChevronDown className={`ml-auto w-4 h-4 text-[#8A9BA8] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-[#3A4858] px-3 pb-3 pt-3 space-y-3">
          <p className="text-[10px] leading-relaxed text-[#8A9BA8]">
            Canonical scenario: exactly one contract/share on each venue. Quantity and settlement distribution cannot rescale execution.
          </p>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,1.7fr)_minmax(0,1fr)] items-center gap-2">
            <div className="rounded-md border border-[#3A4858] bg-[#0E1621] px-2 py-1.5 text-center">
              <div className="font-mono text-xs font-bold text-[#FFFFFF]">0%</div>
              <div className="mt-0.5 text-[9px] text-[#8A9BA8]">Favor PM payout</div>
            </div>
            <input
              aria-label="Profit distribution"
              type="range"
              min="0"
              max="100"
              step="1"
              value={splitPct}
              disabled
              className="w-full accent-[#facc15]"
            />
            <div className="rounded-md border border-[#3A4858] bg-[#0E1621] px-2 py-1.5 text-center">
              <div className="font-mono text-xs font-bold text-[#FFFFFF]">100%</div>
              <div className="mt-0.5 text-[9px] text-[#8A9BA8]">Favor Kalshi payout</div>
            </div>
          </div>
          <div className="flex justify-center text-[10px] text-[#8A9BA8]">
            <span className="font-mono text-[#facc15]">{splitPct}%</span><span className="ml-1">Kalshi payout bias · 50% is balanced</span>
          </div>
          {splitPct !== 50 && (
            <p className="rounded-md border border-[#facc15]/25 bg-[#facc15]/10 px-2 py-1.5 text-[10px] text-[#facc15]">
              Directional split: execute the displayed leg amounts manually. Automatic two-leg execution is available only at the balanced 50% split.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <OrderLeg platform="Kalshi" outcome={kalshiWinLabel.replace('Kalshi ', '')} shares={distribution.kalshiShares} price={kalshiPrice} cost={distribution.kalshiOrderCost} formatCurrency={formatCurrency} />
            <OrderLeg platform="Polymarket" outcome={pmWinLabel.replace('Polymarket ', '')} shares={distribution.pmShares} price={pmPrice} cost={distribution.pmOrderCost} formatCurrency={formatCurrency} />
          </div>
          <div className="rounded-md border border-[#5DBE81]/30 bg-[#5DBE81]/10 px-2.5 py-2 text-center">
            <span className="text-[9px] uppercase tracking-wide text-[#8A9BA8]">Lowest split</span>
            <span className="ml-2 font-mono text-xs font-bold text-[#5DBE81]">
              {distribution.pmToKalshiRatio ? `PM:Kalshi ${distribution.pmToKalshiRatio.label}` : 'PM:Kalshi —'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Scenario label={`If ${kalshiWinLabel} wins`} profit={distribution.netProfitIfKalshiWins} stakeLabel="Kalshi stake" stake={distribution.kalshiStake} formatCurrency={formatCurrency} />
            <Scenario label={`If ${pmWinLabel} wins`} profit={distribution.netProfitIfPmWins} stakeLabel="Polymarket stake" stake={distribution.pmStake} formatCurrency={formatCurrency} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]">
            <Metric label="Kalshi budget" value={formatCurrency(distribution.kalshiStake)} />
            <Metric label="PM budget" value={formatCurrency(distribution.pmStake)} />
            <Metric label="Allocated cost" value={formatCurrency(distribution.totalStake)} strong />
            <Metric label="Recalculated fees" value={`-${formatCurrency(distribution.totalFees)}`} tone="text-[#ef4444]" />
          </div>
        </div>
      )}
    </div>
  );
}

function Scenario({ label, profit, stakeLabel, stake, formatCurrency }: { label: string; profit: number; stakeLabel: string; stake: number; formatCurrency: (value: number) => string }) {
  const positive = profit >= 0;
  return <div className="rounded-md border border-[#3A4858] bg-[#0E1621] p-2.5">
    <div className="text-[10px] text-[#8A9BA8]">{label}</div>
    <div className={`mt-1 font-mono text-sm font-bold ${positive ? 'text-[#5DBE81]' : 'text-[#ef4444]'}`}>{positive ? '+' : ''}{formatCurrency(profit)}</div>
    <div className="mt-1 text-[10px] text-[#8A9BA8]">{stakeLabel}: <span className="font-mono text-[#FFFFFF]">{formatCurrency(stake)}</span></div>
  </div>;
}

function OrderLeg({ platform, outcome, shares, price, cost, formatCurrency }: { platform: string; outcome: string; shares: number; price: number; cost: number; formatCurrency: (value: number) => string }) {
  return <div className="rounded-md border border-[#5DBE81]/30 bg-[#0E1621] p-2.5">
    <div className="text-[10px] text-[#8A9BA8]">Buy {platform} {outcome}</div>
    <div className="mt-1 font-mono text-sm font-bold text-[#FFFFFF]">{shares.toLocaleString()} shares <span className="text-[11px] font-normal text-[#8A9BA8]">@ ${price.toFixed(2)}</span></div>
    <div className="mt-1 text-[10px] text-[#8A9BA8]">Order cost: <span className="font-mono text-[#FFFFFF]">{formatCurrency(cost)}</span></div>
  </div>;
}

function Metric({ label, value, tone = 'text-[#FFFFFF]', strong = false }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return <div className="rounded-md border border-[#3A4858] bg-[#0E1621] px-2 py-1.5">
    <div className="text-[9px] text-[#8A9BA8]">{label}</div>
    <div className={`mt-0.5 font-mono text-[11px] ${strong ? 'font-bold' : ''} ${tone}`}>{value}</div>
  </div>;
}
