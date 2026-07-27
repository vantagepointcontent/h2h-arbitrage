"use client";

import { useMemo, useState } from 'react';
import { AlertTriangle, Calculator } from 'lucide-react';
import { calculateShareStake, parseAskLevelDepth, type ShareStakeStrategy } from '@/lib/share-stake-calculator';

interface Props {
  strategy: ShareStakeStrategy;
  kalshiYesAsk: number;
  kalshiNoAsk: number;
  pmYesAsk: number;
  pmNoAsk: number;
  kalshiAskDepth?: string | number;
  pmAskDepth?: number;
  category?: string;
  formatCurrency: (value: number) => string;
}

export function ShareStakeCalculator({
  strategy, kalshiYesAsk, kalshiNoAsk, pmYesAsk, pmNoAsk, kalshiAskDepth, pmAskDepth, category, formatCurrency,
}: Props) {
  const [rawShares, setRawShares] = useState('1');
  const shares = Number(rawShares);
  const kalshiLabel = strategy === 'Buy YES Kalshi + NO PM' ? 'Kalshi YES' : 'Kalshi NO';
  const pmLabel = strategy === 'Buy YES Kalshi + NO PM' ? 'Polymarket NO' : 'Polymarket YES';
  const calculation = useMemo(() => calculateShareStake({
    strategy,
    shares,
    kalshiYesAsk,
    kalshiNoAsk,
    pmYesAsk,
    pmNoAsk,
    kalshiAvailableShares: parseAskLevelDepth(kalshiAskDepth),
    pmAvailableShares: parseAskLevelDepth(pmAskDepth),
    category,
  }), [strategy, shares, kalshiYesAsk, kalshiNoAsk, pmYesAsk, pmNoAsk, kalshiAskDepth, pmAskDepth, category]);

  const invalidShares = !Number.isFinite(shares) || shares <= 0;
  if (!calculation && !invalidShares) return null;

  return (
    <div className="mt-3 rounded-lg border border-[#3A4858] bg-[#121E2B] px-3 py-3">
      <div className="flex items-center gap-2">
        <Calculator className="h-3.5 w-3.5 text-[#facc15]" />
        <h4 className="text-[11px] font-bold uppercase tracking-wide text-[#FFFFFF]">Share Calculator</h4>
        <label className="ml-auto flex items-center gap-1.5 text-[10px] text-[#8A9BA8]">
          Shares per leg
          <input
            aria-label="Shares per leg"
            type="number"
            min="0.0001"
            step="1"
            inputMode="decimal"
            value={rawShares}
            onChange={(event) => setRawShares(event.target.value)}
            className="w-16 rounded border border-[#3A4858] bg-[#0E1621] px-1.5 py-1 text-right font-mono text-xs text-[#FFFFFF] outline-none focus:border-[#5DBE81]"
          />
        </label>
      </div>

      {invalidShares || !calculation ? (
        <p className="mt-2 text-[10px] text-[#ef4444]">Enter a positive number of shares.</p>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Leg label={kalshiLabel} price={calculation.kalshiPrice} cost={calculation.kalshiCost} available={calculation.kalshiAvailableShares} formatCurrency={formatCurrency} />
            <Leg label={pmLabel} price={calculation.pmPrice} cost={calculation.pmCost} available={calculation.pmAvailableShares} formatCurrency={formatCurrency} />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4">
            <Metric label="Total cost" value={formatCurrency(calculation.totalCost)} />
            <Metric label="Kalshi fee" value={`-${formatCurrency(calculation.kalshiFee)}`} tone="text-[#ef4444]" />
            <Metric label="PM fee" value={`-${formatCurrency(calculation.pmFee)}`} tone="text-[#ef4444]" />
            <Metric label="Net profit" value={`${calculation.netProfit >= 0 ? '+' : ''}${formatCurrency(calculation.netProfit)} (${calculation.netProfitPct.toFixed(2)}%)`} tone={calculation.netProfit >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'} />
          </div>
          {(calculation.exceedsKalshiDepth || calculation.exceedsPmDepth) && (
            <div role="alert" className="mt-2 flex gap-1.5 rounded border border-[#facc15]/30 bg-[#facc15]/10 px-2 py-1.5 text-[10px] text-[#facc15]">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                {calculation.exceedsKalshiDepth && `Only ${formatShares(calculation.kalshiAvailableShares)} shares available at this price on Kalshi.`}
                {calculation.exceedsKalshiDepth && calculation.exceedsPmDepth && ' '}
                {calculation.exceedsPmDepth && `Only ${formatShares(calculation.pmAvailableShares)} shares available at this price on Polymarket.`}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Leg({ label, price, cost, available, formatCurrency }: { label: string; price: number; cost: number; available: number | null; formatCurrency: (value: number) => string }) {
  return <div className="rounded-md border border-[#3A4858] bg-[#0E1621] px-2.5 py-2">
    <div className="text-[10px] text-[#8A9BA8]">Buy {label} @ ${price.toFixed(2)}</div>
    <div className="mt-0.5 font-mono text-xs font-bold text-[#FFFFFF]">Cost: {formatCurrency(cost)}</div>
    <div className={`mt-1 text-[10px] ${available == null ? 'text-[#facc15]' : 'text-[#8A9BA8]'}`}>Available at best ask: {available == null ? 'Unavailable — do not assume fillable' : `${formatShares(available)} shares`}</div>
  </div>;
}

function Metric({ label, value, tone = 'text-[#FFFFFF]' }: { label: string; value: string; tone?: string }) {
  return <div className="rounded-md border border-[#3A4858] bg-[#0E1621] px-2 py-1.5"><div className="text-[9px] text-[#8A9BA8]">{label}</div><div className={`mt-0.5 font-mono text-[11px] font-bold ${tone}`}>{value}</div></div>;
}

function formatShares(value: number | null): string {
  return value == null ? '0' : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
