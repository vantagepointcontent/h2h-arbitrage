// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedMarket, ScanResult } from '@/app/lib/page-shared';
import { SelectedMarketApyProvenance } from './SelectedMarketApyProvenance';

describe('selected-market APY provenance', () => {
  afterEach(() => vi.useRealTimers());

  it('labels a partial zero-match quick refresh unavailable with source, reason, and age', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T18:11:41.000Z'));
    const market: SavedMarket = {
      id: '1782999196726-house-md01',
      eventTitle: 'MD-01 House Election Winner',
      kalshiUrl: 'k',
      polymarketUrl: 'p',
      createdAt: '2026-08-01T00:00:00.000Z',
      canonicalApyPct: 30.02065284618085,
      canonicalApyObservedAt: '2026-08-19T17:41:41.000Z',
      canonicalApySource: 'full_scan',
      canonicalApyRevision: 12,
    };
    const result: ScanResult = {
      eventTitle: market.eventTitle,
      kalshiCount: 0,
      pmCount: 1,
      matchedCount: 0,
      refreshStatus: 'partial',
      _priceDataObservedAt: '2026-08-19T17:41:41.000Z',
      platformDiagnostics: {
        kalshi: { status: 'failed', count: 0, reason: 'Kalshi timed out' },
        polymarket: { status: 'fresh', count: 1 },
      },
      outcomes: [],
      unmatchedKalshi: [],
      unmatchedPolymarket: [],
    };

    render(<SelectedMarketApyProvenance market={market} result={result} />);

    const provenance = screen.getByTestId('selected-market-apy-provenance');
    expect(provenance.textContent).toContain('Persisted scan APY: 30.0% · 30min · revision 12');
    expect(provenance.textContent).toContain('Current quick APY: Unavailable · partial refresh · Kalshi timed out · 30min');
    expect(provenance.textContent).toContain('Saved Markets sorts by persisted scan APY.');
    expect(provenance.textContent).not.toContain('Current quick APY: 0.0%');
  });
});
