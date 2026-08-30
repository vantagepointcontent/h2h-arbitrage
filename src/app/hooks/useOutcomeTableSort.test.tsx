// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { outcomeTableSortScope, useOutcomeTableSort } from './useOutcomeTableSort';

describe('outcomeTableSortScope', () => {
  it('uses the saved id or normalized manual URL pair as the market identity', () => {
    expect(outcomeTableSortScope('saved-a', 'ignored', 'ignored')).toBe('saved:saved-a');
    expect(outcomeTableSortScope(null, ' HTTPS://KALSHI.COM/Market/A ', 'https://polymarket.com/event/b?ref=scan'))
      .toBe('manual:https://kalshi.com/market/a\u0000https://polymarket.com/event/b?ref=scan');
    expect(outcomeTableSortScope(null, '', '')).toBeNull();
  });
});

describe('useOutcomeTableSort', () => {
  it('defaults every opened market to ROI descending without exposing the previous market sort', () => {
    const { result, rerender } = renderHook(
      ({ marketId }) => useOutcomeTableSort(marketId),
      { initialProps: { marketId: 'market-a' as string | null } },
    );

    expect(result.current).toMatchObject({ field: 'roi', direction: 'desc' });

    act(() => result.current.toggle('profit'));
    expect(result.current).toMatchObject({ field: 'profit', direction: 'desc' });

    rerender({ marketId: 'market-b' });
    expect(result.current).toMatchObject({ field: 'roi', direction: 'desc' });

    rerender({ marketId: 'market-a' });
    expect(result.current).toMatchObject({ field: 'roi', direction: 'desc' });
  });

  it('preserves manual column selection and direction toggling during the active market view', () => {
    const { result } = renderHook(() => useOutcomeTableSort('market-a'));

    act(() => result.current.toggle('apy'));
    expect(result.current).toMatchObject({ field: 'apy', direction: 'desc' });

    act(() => result.current.toggle('apy'));
    expect(result.current).toMatchObject({ field: 'apy', direction: 'asc' });

    act(() => result.current.toggle('roi'));
    expect(result.current).toMatchObject({ field: 'roi', direction: 'desc' });
  });

  it('restores ROI descending after an explicit reset', () => {
    const { result } = renderHook(() => useOutcomeTableSort('market-a'));

    act(() => result.current.toggle('profit'));
    act(() => result.current.toggle('profit'));
    expect(result.current).toMatchObject({ field: 'profit', direction: 'asc' });

    act(() => result.current.reset());
    expect(result.current).toMatchObject({ field: 'roi', direction: 'desc' });
  });
});
