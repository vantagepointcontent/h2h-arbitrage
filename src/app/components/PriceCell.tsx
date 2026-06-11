// PriceCell.tsx — Återanvändbar pris-cell med depth och flash-animation
'use client';

import React from 'react';

interface PriceCellProps {
  price: number | null | undefined;
  depth?: string | number | null;
  priceChange?: 'up' | 'down' | null;
  depthLabel?: string; // t.ex. "Likviditet:" eller "Djup:"
}

export function PriceCell({ price, depth, priceChange, depthLabel }: PriceCellProps) {
  const flashClass = priceChange === 'up' ? 'flash-green' : priceChange === 'down' ? 'flash-red' : '';
  
  const formatDepth = (d: string | number | null | undefined): string => {
    if (d === null || d === undefined || d === '') return '';
    if (typeof d === 'number') {
      return `$${d.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    }
    // String: "$1.2K" eller "$500"
    return d.startsWith('$') ? d : `$${d}`;
  };

  return (
    <div className={`flex flex-col items-end ${flashClass}`}>
      <span>{price != null ? price.toFixed(2) : "—"}</span>
      {depth !== undefined && depth !== null && depth !== '' && (
        <span className="text-[10px] text-[#64748b] mt-0.5">
          {depthLabel ? `${depthLabel} ${formatDepth(depth)}` : formatDepth(depth)}
        </span>
      )}
    </div>
  );
}

// SpreadCell — visar spridning med färg
interface SpreadCellProps {
  spread: number;
}

export function SpreadCell({ spread }: SpreadCellProps) {
  const color = spread > 0 ? "text-[#10b981]" : spread < 0 ? "text-[#ef4444]" : "text-[#94a3b8]";
  return (
    <span className={`font-medium ${color}`}>
      {spread > 0 ? "+" : ""}{spread.toFixed(2)}
    </span>
  );
}

// ArbitrageCell — visar ROI + Profit
interface ArbitrageCellProps {
  roiPct: number;
  expectedProfit: number;
  totalStake: number;
  strategy: string;
  isHighestProfit?: boolean;
  totalProfit?: number;
}

export function ArbitrageCell({
  roiPct,
  expectedProfit,
  totalStake,
  strategy,
  isHighestProfit,
  totalProfit,
}: ArbitrageCellProps) {
  const roiColor = roiPct > 5 ? "text-[#10b981]" : roiPct > 0 ? "text-[#fbbf24]" : "text-[#94a3b8]";
  
  const formatCurrency = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  const formatPercent = (n: number) =>
    `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

  return (
    <td className={`relative px-4 py-3 text-right`}>
      {expectedProfit > 0 ? (
        isHighestProfit && totalProfit != null ? (
          <div className="group inline-block">
            <span className="text-[#f1f5f9] cursor-help">
              {formatCurrency(expectedProfit)}{' '}
              <span className="text-[#94a3b8]">({formatCurrency(totalProfit)} total)</span>
            </span>
            {/* Tooltip */}
            <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-56 bg-[#1e293b] border border-[#475569] rounded-lg shadow-xl p-3 text-xs">
              <div className="font-bold text-[#f1f5f9] mb-2">Total Profit Potential</div>
              <div className="text-[#10b981] font-bold text-sm mb-1">{formatCurrency(totalProfit)}</div>
              <div className="text-[#94a3b8] text-xs">{strategy}</div>
              <div className="mt-2 pt-2 border-t border-[#475569]">
                <div className="flex justify-between text-[#94a3b8]">
                  <span>ROI:</span>
                  <span className="text-[#10b981]">{formatPercent(roiPct)}</span>
                </div>
                <div className="flex justify-between text-[#94a3b8]">
                  <span>Stake:</span>
                  <span>{formatCurrency(totalStake)}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <span className="text-[#f1f5f9]">{formatCurrency(expectedProfit)}</span>
        )
      ) : (
        <span className="text-[#94a3b8]">—</span>
      )}
    </td>
  );
}
