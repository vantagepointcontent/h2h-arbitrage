// DepthHeatmap.tsx — visual orderbook depth indicator for arb rows.
// Renders a color-coded horizontal bar (red → yellow → green) showing
// how much capital can actually be deployed at current prices, plus a
// hover tooltip with the full liquidity breakdown.
// Pure rendering — zero API calls; all data is already in the outcome object.
'use client';

import React from 'react';
import { analyzeLiquidity, type LiquidityAnalysis } from '@/lib/liquidity-sizing';

export interface DepthHeatmapProps {
  /** Max fillable stake (already computed) OR raw inputs to compute it */
  maxFillableStake?: number;
  slippageEstimate?: number;
  warningLevel?: 'none' | 'low' | 'critical';
  kalshiDepth?: number;
  polymarketDepth?: number;
  /** Compact format: hide $ text on narrow screens */
  compact?: boolean;
}

// ── Color logic ──────────────────────────────────────────────────
// $0–$500:   red     (#ef4444) — critical, barely executable
// $500–$2000: yellow (#facc15) — low, limited stake
// $2000+:    green   (#5DBE81) — liquid, full deployment
function getTier(stake: number): { color: string; pct: number; label: string } {
  if (stake < 500) {
    // Scale 0–500 → 10%–40% bar width
    const pct = 10 + (stake / 500) * 30;
    return { color: '#ef4444', pct, label: 'critical' };
  }
  if (stake < 2000) {
    // Scale 500–2000 → 40%–70% bar width
    const pct = 40 + ((stake - 500) / 1500) * 30;
    return { color: '#facc15', pct, label: 'low' };
  }
  // $2000+ → 70%–100% bar width, capped at $10K
  const pct = 70 + Math.min((stake - 2000) / 8000, 1) * 30;
  return { color: '#5DBE81', pct, label: 'liquid' };
}

function formatStake(n: number): string {
  if (n >= 10000) return `$${(n / 1000).toFixed(0)}K`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

function DepthHeatmapInner({
  maxFillableStake,
  slippageEstimate,
  warningLevel,
  kalshiDepth,
  polymarketDepth,
  compact = false,
}: DepthHeatmapProps) {
  if (maxFillableStake == null || maxFillableStake <= 0) {
    return <span className="text-[#8A9BA8] text-xs">—</span>;
  }

  const tier = getTier(maxFillableStake);
  const warnLabel = warningLevel === 'none' ? 'DEEP' : warningLevel === 'low' ? 'LIMITED' : 'THIN';

  return (
    <div className="group relative inline-flex items-center gap-1.5">
      {/* Bar */}
      <div
        className={`relative h-4 rounded-sm bg-[#182533] overflow-hidden ${compact ? 'w-10 sm:w-16' : 'w-12 sm:w-20'}`}
        title="Orderbook depth"
      >
        <div
          className="absolute left-0 top-0 h-full rounded-sm transition-all duration-300"
          style={{ width: `${tier.pct}%`, backgroundColor: tier.color }}
        />
      </div>
      {/* $ value — hidden on narrow mobile in compact mode */}
      <span
        className={`text-xs font-mono font-medium ${compact ? 'hidden sm:inline' : ''}`}
        style={{ color: tier.color }}
        title="Max fillable stake (min of Kalshi + PM depth)"
      >
        <span className="text-[#8A9BA8] text-[10px]">Max:</span> {formatStake(maxFillableStake)}
      </span>
      {/* Tooltip on hover */}
      <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-56 bg-[#17212B] border border-[#232E3C] rounded-lg shadow-xl p-3 text-xs pointer-events-none whitespace-normal">
        <div className="font-bold text-[#FFFFFF] mb-2">Liquidity Breakdown</div>
        <div className="space-y-1">
          <div className="flex justify-between">
            <span className="text-[#8A9BA8]">Max fillable stake</span>
            <span className="font-bold text-[#FFFFFF]">{formatStake(maxFillableStake)}</span>
          </div>
          {slippageEstimate != null && (
            <div className="flex justify-between">
              <span className="text-[#8A9BA8]">Est. slippage</span>
              <span className="text-[#FFFFFF]">~{slippageEstimate.toFixed(1)}%</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-[#8A9BA8]">Warning level</span>
            <span
              className={
                warningLevel === 'none'
                  ? 'text-[#5DBE81]'
                  : warningLevel === 'low'
                  ? 'text-[#facc15]'
                  : 'text-[#ef4444]'
              }
            >
              {warnLabel}
            </span>
          </div>
          {kalshiDepth != null && (
            <div className="flex justify-between">
              <span className="text-[#8A9BA8]">Kalshi depth</span>
              <span className="text-[#8A9BA8]">{kalshiDepth > 0 ? formatStake(kalshiDepth) : '—'}</span>
            </div>
          )}
          {polymarketDepth != null && (
            <div className="flex justify-between">
              <span className="text-[#8A9BA8]">Polymarket depth</span>
              <span className="text-[#8A9BA8]">
                {Number.isFinite(polymarketDepth) ? formatStake(polymarketDepth) : '∞ (rule)'}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const DepthHeatmap = React.memo(DepthHeatmapInner);

// ── Helper: compute LiquidityAnalysis from raw outcome fields ──────
// Mirrors the logic in ExecutionReadiness.tsx for client-side computation
// from the raw Kalshi/PM depth fields present in the scan results outcome.

/** Parse Kalshi's formatted depth strings ("$1,000") to a number. */
export function parseDepth(d?: string | number | null): number {
  if (d == null) return 0;
  if (typeof d === 'number') return Number.isFinite(d) ? d : 0;
  const n = parseFloat(String(d).replace(/[$,\s]/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Compute a LiquidityAnalysis from the raw outcome fields found in
 * OutcomeTableBody's Outcome interface. Returns null if data is missing.
 */
export function computeLiquidityFromOutcome(
  kalshi?: { yesAsk: number; noAsk: number; yesAskDepth?: string; noAskDepth?: string } | null,
  polymarket?: { yesPrice: number; noPrice: number; askDepth?: number; noAskDepth?: number } | null,
  arbitrage?: { kalshiStake?: number; pmStake?: number; fees?: { kalshiFee: number; pmFee: number } },
): LiquidityAnalysis | null {
  if (!kalshi || !polymarket) return null;

  const kalshiDepth = parseDepth(kalshi.yesAskDepth);
  const pmDepthRaw = polymarket.askDepth;
  // MF-001: missing CLOB depth is non-executable, never assumed infinite.
  const pmDepth = pmDepthRaw != null && Number.isFinite(pmDepthRaw) && pmDepthRaw > 0 ? pmDepthRaw : 0;

  const totalStake = (arbitrage?.kalshiStake ?? 0) + (arbitrage?.pmStake ?? 0);
  const feeRates = {
    kalshiFee: totalStake > 0 ? (arbitrage?.fees?.kalshiFee ?? 0) / totalStake : 0,
    pmFee: totalStake > 0 ? (arbitrage?.fees?.pmFee ?? 0) / totalStake : 0,
  };

  return analyzeLiquidity(
    kalshi.yesAsk,
    kalshiDepth,
    polymarket.yesPrice,
    pmDepth,
    kalshi.noAsk,
    polymarket.noPrice,
    feeRates,
  );
}