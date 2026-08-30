// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketWorkspaceHeader } from './MarketWorkspaceHeader';
import type { VenuePriceFreshnessMap } from '@/app/lib/page-shared';

const noop = () => {};
const baseProps = {
  market: { id: 'market-1', title: 'Market', kalshiUrl: 'https://kalshi.test', polymarketUrl: 'https://pm.test' },
  outcomes: [], loading: false, refreshing: false, favorite: false, copied: false,
  activeTab: 'prices' as const, onTabChange: noop, onFavorite: noop, onRefresh: noop,
  onInspect: noop, onRescan: noop, onEdit: noop, onCopy: noop, onCouplings: noop, onDelete: noop,
};

function renderHeader(priceFreshness: VenuePriceFreshnessMap) {
  render(<MarketWorkspaceHeader {...baseProps} priceFreshness={priceFreshness} nowMs={Date.parse('2026-08-30T12:10:00.000Z')} />);
}

describe('UI-121 venue price age header', () => {
  it('renders independently aged fresh venues with full accessible provenance', () => {
    renderHeader({
      kalshi: { status: 'fresh', observedAt: '2026-08-30T12:09:30.000Z', source: 'saved-market-full-scan', reason: null },
      polymarket: { status: 'fresh', observedAt: '2026-08-30T12:09:50.000Z', source: 'saved-market-quick-refresh', reason: null },
    });

    expect(screen.getByText('Kalshi price age')).toBeTruthy();
    expect(screen.getByText('PM price age')).toBeTruthy();
    expect(screen.getByLabelText(/Kalshi price age: Fresh · 30s.*2026-08-30T12:09:30.000Z.*saved-market-full-scan/)).toBeTruthy();
    expect(screen.getByLabelText(/Polymarket price age: Fresh · 10s.*2026-08-30T12:09:50.000Z.*saved-market-quick-refresh/)).toBeTruthy();
  });

  it.each([
    ['credentials_unavailable', 'Credentials unavailable'],
    ['failed', 'Failed'],
    ['rate_limited', 'Rate limited'],
    ['stale_last_known', 'Stale last-known'],
  ] as const)('shows retained Kalshi age for %s without changing fresh PM age', (status, label) => {
    renderHeader({
      kalshi: { status, observedAt: '2026-08-30T11:10:00.000Z', source: 'saved-market-full-scan', reason: 'Kalshi credentials unavailable' },
      polymarket: { status: 'fresh', observedAt: '2026-08-30T12:09:50.000Z', source: 'saved-market-quick-refresh', reason: null },
    });

    expect(screen.getByLabelText(new RegExp(`Kalshi price age: ${label} · 1h`))).toBeTruthy();
    expect(screen.getByLabelText(/Polymarket price age: Fresh · 10s/)).toBeTruthy();
  });

  it('shows an explicit reason when displayed prices have no trustworthy timestamp', () => {
    renderHeader({
      kalshi: { status: 'credentials_unavailable', observedAt: null, source: null, reason: 'Kalshi credentials unavailable' },
      polymarket: { status: 'not_scanned', observedAt: null, source: null, reason: 'No Polymarket price snapshot has been recorded' },
    });

    expect(screen.getByText('Age unavailable · Credentials unavailable')).toBeTruthy();
    expect(screen.getByText('Age unavailable · Not scanned')).toBeTruthy();
    expect(screen.getByLabelText(/Kalshi price age: Age unavailable · Credentials unavailable.*Kalshi credentials unavailable/)).toBeTruthy();
  });

  it('ages a previously successful persisted snapshot into stale last-known without a new request', () => {
    renderHeader({
      kalshi: { status: 'fresh', observedAt: '2026-08-30T11:50:00.000Z', source: 'saved-market-full-scan', reason: null },
      polymarket: { status: 'fresh', observedAt: '2026-08-30T12:09:50.000Z', source: 'saved-market-quick-refresh', reason: null },
    });

    expect(screen.getByLabelText(/Kalshi price age: Stale last-known · 20min/)).toBeTruthy();
    expect(screen.getByLabelText(/Polymarket price age: Fresh · 10s/)).toBeTruthy();
  });

  it('shows the same cached-failure lifecycle summary as the sidebar', () => {
    const lifecycle = {
      overallStatus: 'failed' as const,
      fullScan: {
        status: 'failed' as const, attemptedAt: '2026-08-30T12:00:00.000Z', completedAt: null,
        observedAt: '2026-08-30T11:10:00.000Z', lastSuccessAt: '2026-08-30T11:10:00.000Z', reason: 'Kalshi HTTP 503',
      },
      manualRefresh: {
        status: 'not_refreshed' as const, attemptedAt: null, completedAt: null, observedAt: null,
        lastSuccessAt: null, reason: null,
      },
      venues: {
        kalshi: { status: 'failed' as const, observedAt: null, reason: 'Kalshi HTTP 503' },
        polymarket: { status: 'fresh' as const, observedAt: '2026-08-30T11:10:00.000Z', reason: null },
      },
      cachedData: { status: 'available' as const, observedAt: '2026-08-30T11:10:00.000Z' },
    };
    const priceFreshness: VenuePriceFreshnessMap = {
      kalshi: { status: 'failed', observedAt: '2026-08-30T11:10:00.000Z', source: 'saved-market-full-scan', reason: 'Kalshi HTTP 503' },
      polymarket: { status: 'fresh', observedAt: '2026-08-30T11:10:00.000Z', source: 'saved-market-full-scan', reason: null },
    };

    render(<MarketWorkspaceHeader {...baseProps} lifecycle={lifecycle} priceFreshness={priceFreshness} nowMs={Date.parse('2026-08-30T12:10:00.000Z')} />);

    expect(screen.getByRole('status').textContent).toBe('Last scan failed · showing data from 1h ago');
    expect(screen.getByRole('status').title).toBe('Kalshi HTTP 503');
  });
});