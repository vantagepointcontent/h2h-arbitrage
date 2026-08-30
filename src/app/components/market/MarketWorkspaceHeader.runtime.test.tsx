// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarketWorkspaceHeader } from './MarketWorkspaceHeader';
import { buildSavedMarketLifecycle } from '@/lib/saved-market-lifecycle';

it('keeps the selected market usable when persisted venue freshness is missing', () => {
  render(<MarketWorkspaceHeader
    market={{ id: 'market-a', eventTitle: 'Market A', kalshiUrl: 'https://kalshi.com/a', polymarketUrl: 'https://polymarket.com/a' }}
    outcomes={[]}
    priceFreshness={undefined as never}
    loading={false}
    refreshing={false}
    favorite={false}
    copied={false}
    activeTab="prices"
    onTabChange={vi.fn()}
    onFavorite={vi.fn()}
    onRefresh={vi.fn()}
    onInspect={vi.fn()}
    onRescan={vi.fn()}
    onEdit={vi.fn()}
    onCopy={vi.fn()}
    onCouplings={vi.fn()}
    onDelete={vi.fn()}
  />);

  expect(screen.getByRole('heading', { name: 'Market A' })).toBeTruthy();
  expect(screen.getByLabelText(/Kalshi price age: Age unavailable · Not scanned/)).toBeTruthy();
  expect(screen.getByLabelText(/Polymarket price age: Age unavailable · Not scanned/)).toBeTruthy();
});

it('shows the same cached-data lifecycle explanation as the saved-market sidebar', () => {
  const now = Date.parse('2026-08-30T17:00:00.000Z');
  const lifecycle = buildSavedMarketLifecycle({
    scheduler: {
      lastAttemptAt: '2026-08-30T16:50:00.000Z',
      lastSuccessAt: '2026-08-30T16:00:00.000Z',
      failureReason: 'kalshi_market_data_unavailable: Kalshi returned no usable market data.',
    },
    lastScanResult: { matchStatus: 'matched', scannedAt: '2026-08-30T16:00:00.000Z' },
    liveResult: null,
  }, now);

  render(<MarketWorkspaceHeader
    market={{ id: 'market-a', eventTitle: 'Market A', kalshiUrl: 'https://kalshi.com/a', polymarketUrl: 'https://polymarket.com/a' }}
    outcomes={[]}
    lifecycle={lifecycle}
    priceFreshness={{
      kalshi: { status: 'stale_last_known', observedAt: '2026-08-30T16:00:00.000Z', source: 'saved-market-full-scan', reason: null },
      polymarket: { status: 'stale_last_known', observedAt: '2026-08-30T16:00:00.000Z', source: 'saved-market-full-scan', reason: null },
    }}
    nowMs={now}
    loading={false} refreshing={false} favorite={false} copied={false} activeTab="prices"
    onTabChange={vi.fn()} onFavorite={vi.fn()} onRefresh={vi.fn()} onInspect={vi.fn()}
    onRescan={vi.fn()} onEdit={vi.fn()} onCopy={vi.fn()} onCouplings={vi.fn()} onDelete={vi.fn()}
  />);

  const status = screen.getByRole('status');
  expect(status.textContent).toBe('Last scan failed · showing data from 1h ago');
  expect(status.getAttribute('title')).toContain('Kalshi returned no usable market data');
});
