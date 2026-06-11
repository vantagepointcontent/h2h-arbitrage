// MarketTable.tsx — Komplett marknadstabell med expanderbara rader
'use client';

import React, { useState, useCallback } from 'react';
import { MarketRow } from './MarketRow';

interface UnifiedOutcome {
  artist: string;
  kalshi?: {
    yesAsk: number;
    noAsk: number;
    yesAskDepth?: string;
    noAskDepth?: string;
  };
  polymarket?: {
    yesPrice: number;
    noPrice: number;
    askDepth?: number;
    noAskDepth?: number;
  };
  arbitrage: {
    strategy: string;
    roiPct: number;
    expectedProfit: number;
    totalStake: number;
    maxCapital: number;
    apyPct: number;
    kalshiStake: number;
    pmStake: number;
  };
}

interface MarketTableProps {
  outcomes: UnifiedOutcome[];
  priceChanges: Map<string, 'up' | 'down'>;
  highestProfitArtist: string | null;
  totalProfit: number;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  onSort: (field: string) => void;
}

const SORTABLE_FIELDS = [
  { key: 'artist', label: 'Outcome' },
  { key: 'kalshiYes', label: 'Kalshi YES' },
  { key: 'kalshiNo', label: 'Kalshi NO' },
  { key: 'pmYes', label: 'PM YES' },
  { key: 'pmNo', label: 'PM NO' },
  { key: 'spread', label: 'Spread' },
  { key: 'roi', label: 'ROI %' },
  { key: 'profit', label: 'Profit' },
  { key: 'apy', label: 'APY %' },
  { key: 'capital', label: 'Capital' },
  { key: 'strategy', label: 'Strategy' },
];

export function MarketTable({
  outcomes,
  priceChanges,
  highestProfitArtist,
  totalProfit,
  sortField,
  sortDirection,
  onSort,
}: MarketTableProps) {
  const [expandedArtist, setExpandedArtist] = useState<string | null>(null);

  const toggleExpand = useCallback((artist: string) => {
    setExpandedArtist(prev => prev === artist ? null : artist);
  }, []);

  const handleSort = useCallback((field: string) => {
    onSort(field);
  }, [onSort]);

  if (outcomes.length === 0) {
    return (
      <div className="text-center py-12 text-[#8A9BA8]">
        Inga matchade outcomes hittades.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[#232E3C] text-[#8A9BA8] text-xs uppercase tracking-wider">
            {SORTABLE_FIELDS.map((field) => (
              <th
                key={field.key}
                className={`px-4 py-3 text-left font-semibold cursor-pointer hover:text-[#FFFFFF] transition-colors ${
                  sortField === field.key ? 'text-[#FFFFFF]' : ''
                }`}
                onClick={() => handleSort(field.key)}
              >
                <div className="flex items-center gap-1">
                  {field.label}
                  {sortField === field.key && (
                    <span className="text-[#FFFFFF]">
                      {sortDirection === 'asc' ? ' ↑' : ' ↓'}
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#17212B]">
          {outcomes.map((outcome) => (
            <MarketRow
              key={outcome.artist}
              artist={outcome.artist}
              kalshi={outcome.kalshi}
              polymarket={outcome.polymarket}
              arbitrage={outcome.arbitrage}
              priceChanges={priceChanges}
              isExpanded={expandedArtist === outcome.artist}
              isHighestProfit={outcome.artist === highestProfitArtist}
              totalProfit={totalProfit}
              onToggleExpand={() => toggleExpand(outcome.artist)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
