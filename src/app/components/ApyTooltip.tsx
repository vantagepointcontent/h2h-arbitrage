// ApyTooltip.tsx — UI-15: APY explanation tooltip + market title hover tooltips
// UI-20: Generic HeaderInfo for all column headers
'use client';

import React from 'react';
import { Info } from 'lucide-react';

/* ── Generic Header Info Icon ── */
// Small info icon with native title tooltip — works on desktop (hover)
// and mobile (tap-hold). Not clipped by overflow-hidden containers.
// Use this for ANY column header that needs an explanation.

export function HeaderInfo({ text }: { text: string }) {
  return (
    <span
      className="inline-flex items-center text-[#8A9BA8] hover:text-[#FFFFFF] transition-colors cursor-help"
      title={text}
    >
      <Info className="w-3 h-3" />
    </span>
  );
}

/* ── APY Header Info Icon ── */
// Small info icon to place next to "APY" column headers.
// Uses native title attr for simplicity + no layout shift.

export function ApyHeaderInfo() {
  return (
    <HeaderInfo text="Annualized ROI = ROI × (365 ÷ days to expiry).\nExample: 2% ROI on a 7-day market = 10,400% annualized (104x).\nHigher APY = better return relative to time held." />
  );
}

/* ── APY Value Tooltip ── */
// Wraps an APY value in a hover group that shows the breakdown:
// ROI, days to expiry, and the annualized calculation.

interface ApyValueTooltipProps {
  apy: number;
  roi: number;
  daysToExpiry: number | null;
  children: React.ReactNode;
}

export function ApyValueTooltip({ apy, roi, daysToExpiry, children }: ApyValueTooltipProps) {
  if (apy === 0 || daysToExpiry == null || daysToExpiry <= 0) {
    return <>{children}</>;
  }

  const apyLabel = apy > 0
    ? `+${(apy / 100).toFixed(1)}%`
    : `${(apy / 100).toFixed(1)}%`;
  const multiplier = (apy / 100).toFixed(1);
  const xLabel = `${multiplier}x`;

  return (
    <div className="group relative inline-block">
      {children}
      <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-64 bg-[#17212B] border border-[#232E3C] rounded-lg shadow-xl p-3 text-xs whitespace-normal">
        <div className="font-bold text-[#FFFFFF] mb-2">APY Breakdown</div>
        <div className="space-y-1">
          <div className="flex justify-between text-[#8A9BA8]">
            <span>ROI</span>
            <span className="text-[#FFFFFF]">{roi > 0 ? "+" : ""}{(roi / 100).toFixed(1)}%</span>
          </div>
          <div className="flex justify-between text-[#8A9BA8]">
            <span>Days to expiry</span>
            <span className="text-[#FFFFFF]">{Math.round(daysToExpiry)}</span>
          </div>
          <div className="flex justify-between text-[#8A9BA8]">
            <span>Annualization</span>
            <span className="text-[#FFFFFF]">×{Math.round(365 / daysToExpiry)}</span>
          </div>
        </div>
        <div className="flex justify-between text-[#FFFFFF] font-medium border-t border-[#182533] pt-2 mt-2">
          <span>Annualized (APY)</span>
          <span className="text-[#5DBE81] font-bold">{apyLabel}</span>
        </div>
        <div className="text-[10px] text-[#8A9BA8] mt-2 border-t border-[#182533] pt-2">
          {((roi / 100)).toFixed(1)}% ROI × (365 ÷ {Math.round(daysToExpiry)} days) = {apyLabel} ({xLabel})
        </div>
      </div>
    </div>
  );
}

/* ── Market Title Tooltip ── */
// Builds a title attribute string for a saved market with key metadata.
// Used on market title elements in sidebar, overview, and outcome views.

interface MarketTitleTooltipProps {
  eventTitle: string;
  expiryDate?: string | null;
  category?: string;
  scannedAt?: string | null;
}

export function buildMarketTooltip({ eventTitle, expiryDate, category, scannedAt }: MarketTitleTooltipProps): string {
  const parts: string[] = [eventTitle];
  if (expiryDate) {
    const d = new Date(expiryDate);
    const dateStr = d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    parts.push(`Expiry: ${dateStr}`);
  }
  if (category) parts.push(`Category: ${category}`);
  if (scannedAt) {
    const d = new Date(scannedAt);
    const timeStr = d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    parts.push(`Last scan: ${timeStr}`);
  }
  return parts.join("\n");
}

/* ── Helper: compute days to expiry ── */
export function getDaysToExpiry(expiryDate?: string | null): number | null {
  if (!expiryDate) return null;
  const expiry = new Date(expiryDate).getTime();
  const now = Date.now();
  if (expiry <= now) return null;
  return (expiry - now) / (1000 * 60 * 60 * 24);
}