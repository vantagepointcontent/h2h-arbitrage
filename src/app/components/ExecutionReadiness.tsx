// ExecutionReadiness.tsx — the "can I actually take this trade?" decision view.
// Composes liquidity analysis (max fillable stake, slippage, depth constraint)
// with the fee breakdown so an arb can be evaluated in one glance.
'use client';

import React from 'react';
import { analyzeLiquidity } from '@/lib/liquidity-sizing';

interface ExecutionReadinessProps {
  kalshi?: { yesAsk: number; noAsk: number; yesAskDepth?: string; noAskDepth?: string } | null;
  polymarket?: { yesPrice: number; noPrice: number; askDepth?: number; noAskDepth?: number } | null;
  arbitrage: {
    strategy: string;
    kalshiStake?: number;
    pmStake?: number;
    expectedProfit: number;
    roiPct: number;
    fees?: {
      kalshiFee: number;
      pmFee: number;
      kalshiFeeDetails: string;
      pmFeeDetails: string;
      worstCaseNetProfit: number;
    };
  };
  formatCurrency: (n: number) => string;
}

/** Parse Kalshi's formatted depth strings ("$1,000") to a number. */
function parseDepth(d?: string | number | null): number {
  if (d == null) return 0;
  if (typeof d === 'number') return Number.isFinite(d) ? d : 0;
  const n = parseFloat(String(d).replace(/[$,\s]/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

const WARNING_STYLES: Record<string, { label: string; cls: string }> = {
  none:     { label: 'DEEP',    cls: 'bg-[#5DBE81]/15 text-[#5DBE81]' },
  low:      { label: 'LIMITED', cls: 'bg-[#f59e0b]/15 text-[#f59e0b]' },
  critical: { label: 'THIN',    cls: 'bg-[#ef4444]/15 text-[#ef4444]' },
};

function ExecutionReadinessInner({ kalshi, polymarket, arbitrage, formatCurrency }: ExecutionReadinessProps) {
  if (!kalshi || !polymarket || arbitrage.strategy === 'No arb') return null;

  const kalshiDepth = parseDepth(kalshi.yesAskDepth);
  // PM depth: use real value when present; Infinity per project rule otherwise
  const pmDepthRaw = polymarket.askDepth;
  const pmDepth = pmDepthRaw != null && Number.isFinite(pmDepthRaw) && pmDepthRaw > 0 ? pmDepthRaw : Infinity;

  const totalStake = (arbitrage.kalshiStake ?? 0) + (arbitrage.pmStake ?? 0);
  const feeRates = {
    kalshiFee: totalStake > 0 ? (arbitrage.fees?.kalshiFee ?? 0) / totalStake : 0,
    pmFee: totalStake > 0 ? (arbitrage.fees?.pmFee ?? 0) / totalStake : 0,
  };

  const liq = analyzeLiquidity(
    kalshi.yesAsk,
    kalshiDepth,
    polymarket.yesPrice,
    pmDepth,
    kalshi.noAsk,
    polymarket.noPrice,
    feeRates,
  );

  const warn = WARNING_STYLES[liq.warningLevel] ?? WARNING_STYLES.critical;
  const bindingSide = kalshiDepth <= (Number.isFinite(pmDepth) ? pmDepth : Infinity) ? 'Kalshi' : 'Polymarket';
  const captureRatio = Math.round(liq.realToTheoreticalRatio * 100);

  return (
    <div className="mt-2 rounded-lg border border-[#232E3C] bg-[#0E1621]/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-[#8A9BA8]">Execution readiness</span>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${warn.cls}`}>{warn.label} LIQUIDITY</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        {/* Max fillable stake */}
        <div>
          <div className="text-[#5E6875] text-[10px] uppercase">Max fillable</div>
          <div className="font-bold text-[#FFFFFF] text-sm">{formatCurrency(liq.maxFillableStake)}</div>
          <div className="text-[10px] text-[#5E6875]">binding: {bindingSide}</div>
        </div>

        {/* Slippage */}
        <div>
          <div className="text-[#5E6875] text-[10px] uppercase">Est. slippage</div>
          <div className={`font-bold text-sm ${liq.slippageEstimate >= 2 ? 'text-[#ef4444]' : liq.slippageEstimate >= 1 ? 'text-[#f59e0b]' : 'text-[#5DBE81]'}`}>
            ~{liq.slippageEstimate.toFixed(1)}%
          </div>
          <div className="text-[10px] text-[#5E6875]">at max fill</div>
        </div>

        {/* Realistic profit */}
        <div>
          <div className="text-[#5E6875] text-[10px] uppercase">Realistic profit</div>
          <div className={`font-bold text-sm ${liq.realisticProfit > 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}`}>
            {formatCurrency(liq.realisticProfit)}
          </div>
          <div className="text-[10px] text-[#5E6875]">{captureRatio}% of theoretical</div>
        </div>

        {/* Fees */}
        <div>
          <div className="text-[#5E6875] text-[10px] uppercase">Fees (both legs)</div>
          <div className="font-bold text-sm text-[#FFFFFF]">
            {formatCurrency((arbitrage.fees?.kalshiFee ?? 0) + (arbitrage.fees?.pmFee ?? 0))}
          </div>
          <div className="text-[10px] text-[#5E6875]">
            K {formatCurrency(arbitrage.fees?.kalshiFee ?? 0)} · PM {formatCurrency(arbitrage.fees?.pmFee ?? 0)}
          </div>
        </div>
      </div>

      {/* Depth detail row */}
      <div className="mt-2 pt-2 border-t border-[#182533] flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[#5E6875]">
        <span>Kalshi depth: <span className="text-[#8A9BA8] font-medium">{kalshiDepth > 0 ? formatCurrency(kalshiDepth) : '—'}</span></span>
        <span>PM depth: <span className="text-[#8A9BA8] font-medium">{Number.isFinite(pmDepth) ? formatCurrency(pmDepth) : '∞ (project rule)'}</span></span>
        {arbitrage.fees && (
          <span>Worst-case net: <span className={`font-medium ${arbitrage.fees.worstCaseNetProfit >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}`}>{formatCurrency(arbitrage.fees.worstCaseNetProfit)}</span></span>
        )}
        {!liq.isLiquid && <span className="text-[#ef4444] font-medium">⚠ Under $100 fillable — likely not worth execution</span>}
      </div>
    </div>
  );
}

export const ExecutionReadiness = React.memo(ExecutionReadinessInner);
