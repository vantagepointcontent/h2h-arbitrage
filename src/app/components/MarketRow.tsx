// MarketRow.tsx — Renderar en rad i marknadstabellen
'use client';

import React from 'react';
import { PriceCell, SpreadCell } from './PriceCell';

interface KalshiData {
  yesAsk: number;
  noAsk: number;
  yesAskDepth?: string;
  noAskDepth?: string;
}

interface PolymarketData {
  yesPrice: number;
  noPrice: number;
  askDepth?: number;
  noAskDepth?: number;
}

interface ArbitrageData {
  strategy: string;
  roiPct: number;
  expectedProfit: number;
  totalStake: number;
  maxCapital: number;
  apyPct: number;
  kalshiStake: number;
  pmStake: number;
}

interface MarketRowProps {
  artist: string;
  kalshi?: KalshiData;
  polymarket?: PolymarketData;
  arbitrage: ArbitrageData;
  priceChanges: Map<string, 'up' | 'down'>;
  isExpanded: boolean;
  isHighestProfit: boolean;
  totalProfit: number;
  onToggleExpand: () => void;
}

function formatCurrency(n: number) {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(n: number) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

export function MarketRow({
  artist,
  kalshi,
  polymarket,
  arbitrage,
  priceChanges,
  isExpanded,
  isHighestProfit,
  totalProfit,
  onToggleExpand,
}: MarketRowProps) {
  const spread = (kalshi?.yesAsk ?? 0) - (polymarket?.yesPrice ?? 0);
  const roiColor = arbitrage.roiPct > 5 ? "text-[#10b981]" : arbitrage.roiPct > 0 ? "text-[#fbbf24]" : "text-[#94a3b8]";

  return (
    <React.Fragment>
      <tr
        className={`hover:bg-[#334155]/50 transition-colors cursor-pointer ${isExpanded ? "bg-[#334155]/30" : ""}`}
        onClick={onToggleExpand}
      >
        <td className="px-4 py-3 font-medium text-[#f1f5f9] flex items-center gap-1.5">
          <span className={`transition-transform text-[#94a3b8] ${isExpanded ? "rotate-90" : ""}`}>&#9654;</span>
          {artist}
        </td>
        <td className="px-4 py-3 text-right text-[#f1f5f9]">
          <PriceCell
            price={kalshi?.yesAsk ?? null}
            depth={kalshi?.yesAskDepth}
            priceChange={priceChanges.get(artist) ?? null}
            depthLabel="Djup:"
          />
        </td>
        <td className="px-4 py-3 text-right text-[#f1f5f9]">
          <PriceCell
            price={kalshi?.noAsk ?? null}
            depth={kalshi?.noAskDepth}
            priceChange={priceChanges.get(artist) ?? null}
            depthLabel="Djup:"
          />
        </td>
        <td className="px-4 py-3 text-right text-[#f1f5f9]">
          <PriceCell
            price={polymarket?.yesPrice ?? null}
            depth={polymarket?.askDepth}
            priceChange={priceChanges.get(artist) ?? null}
            depthLabel="Likviditet:"
          />
        </td>
        <td className="px-4 py-3 text-right text-[#f1f5f9]">
          <PriceCell
            price={polymarket?.noPrice ?? null}
            depth={polymarket?.noAskDepth}
            priceChange={priceChanges.get(artist) ?? null}
            depthLabel="Likviditet:"
          />
        </td>
        <td className="px-4 py-3 text-right">
          <SpreadCell spread={spread} />
        </td>
        <td className={`px-4 py-3 text-right font-bold ${roiColor}`}>
          {formatPercent(arbitrage.roiPct)}
        </td>
        <td className="relative px-4 py-3 text-right">
          {arbitrage.expectedProfit > 0 ? (
            isHighestProfit && totalProfit > 0 ? (
              <div className="group inline-block">
                <span className="text-[#f1f5f9] cursor-help">
                  {formatCurrency(arbitrage.expectedProfit)}{' '}
                  <span className="text-[#94a3b8]">({formatCurrency(totalProfit)} total)</span>
                </span>
                <div className="invisible group-hover:visible absolute bottom-full right-0 z-50 mb-2 w-56 bg-[#1e293b] border border-[#475569] rounded-lg shadow-xl p-3 text-xs">
                  <div className="font-bold text-[#f1f5f9] mb-2">Total Profit Potential</div>
                  <div className="text-[#10b981] font-bold text-sm mb-1">{formatCurrency(totalProfit)}</div>
                  <div className="text-[#94a3b8] text-xs">{arbitrage.strategy}</div>
                  <div className="mt-2 pt-2 border-t border-[#475569]">
                    <div className="flex justify-between text-[#94a3b8]">
                      <span>ROI:</span>
                      <span className="text-[#10b981]">{formatPercent(arbitrage.roiPct)}</span>
                    </div>
                    <div className="flex justify-between text-[#94a3b8]">
                      <span>Stake:</span>
                      <span>{formatCurrency(arbitrage.totalStake)}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <span className="text-[#f1f5f9]">{formatCurrency(arbitrage.expectedProfit)}</span>
            )
          ) : (
            <span className="text-[#94a3b8]">—</span>
          )}
        </td>
        <td className={`px-4 py-3 text-right font-medium ${roiColor}`}>
          {formatPercent(arbitrage.apyPct)}
        </td>
        <td className="px-4 py-3 text-right text-[#f1f5f9]">
          {formatCurrency(arbitrage.maxCapital)}
        </td>
        <td className="px-4 py-3 text-right text-[#94a3b8] text-xs">
          {arbitrage.strategy === 'No arb' ? '-' : arbitrage.strategy.replace(/Buy\s+(YES|NO)\s+Kalshi\s+\+\s+(YES|NO)\s+PM/, '$1K+$2P')}
        </td>
      </tr>
      
      {/* Expanded detail row */}
      {isExpanded && arbitrage.strategy !== 'No arb' && (
        <tr className="bg-[#1e293b]/50">
          <td colSpan={12} className="px-4 py-4">
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-[#94a3b8] text-xs mb-1">Kalshi Stake</div>
                <div className="text-[#f1f5f9] font-medium">{formatCurrency(arbitrage.kalshiStake)}</div>
              </div>
              <div>
                <div className="text-[#94a3b8] text-xs mb-1">PM Stake</div>
                <div className="text-[#f1f5f9] font-medium">{formatCurrency(arbitrage.pmStake)}</div>
              </div>
              <div>
                <div className="text-[#94a3b8] text-xs mb-1">Strategy</div>
                <div className="text-[#f1f5f9] font-medium">{arbitrage.strategy}</div>
              </div>
              <div>
                <div className="text-[#94a3b8] text-xs mb-1">Capital</div>
                <div className="text-[#f1f5f9] font-medium">{formatCurrency(arbitrage.maxCapital)}</div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}
