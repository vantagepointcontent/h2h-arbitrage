'use client';

import { useCallback, useState } from 'react';

export type OutcomeSortField = 'roi' | 'apy' | 'profit' | 'spread';
export type OutcomeSortDirection = 'asc' | 'desc';

export const DEFAULT_OUTCOME_SORT = Object.freeze({
  field: 'roi' as const,
  direction: 'desc' as const,
});

export function outcomeTableSortScope(
  marketId: string | null,
  kalshiUrl: string,
  polymarketUrl: string,
): string | null {
  if (marketId) return `saved:${marketId}`;
  const normalizedKalshiUrl = kalshiUrl.trim().toLowerCase();
  const normalizedPolymarketUrl = polymarketUrl.trim().toLowerCase();
  return normalizedKalshiUrl && normalizedPolymarketUrl
    ? `manual:${normalizedKalshiUrl}\u0000${normalizedPolymarketUrl}`
    : null;
}

type OutcomeSortState = {
  marketId: string | null;
  field: OutcomeSortField;
  direction: OutcomeSortDirection;
};

export function useOutcomeTableSort(marketId: string | null) {
  const [sort, setSort] = useState<OutcomeSortState>({
    marketId,
    ...DEFAULT_OUTCOME_SORT,
  });
  const activeSort = sort.marketId === marketId ? sort : { marketId, ...DEFAULT_OUTCOME_SORT };

  if (sort.marketId !== marketId) {
    setSort({ marketId, ...DEFAULT_OUTCOME_SORT });
  }

  const toggle = useCallback((field: OutcomeSortField) => {
    setSort((current) => {
      const effective = current.marketId === marketId ? current : { marketId, ...DEFAULT_OUTCOME_SORT };
      return {
        marketId,
        field,
        direction: effective.field === field
          ? effective.direction === 'asc' ? 'desc' : 'asc'
          : 'desc',
      };
    });
  }, [marketId]);

  const reset = useCallback(() => {
    setSort({ marketId, ...DEFAULT_OUTCOME_SORT });
  }, [marketId]);

  return {
    field: activeSort.field,
    direction: activeSort.direction,
    toggle,
    reset,
  };
}
