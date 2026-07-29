// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import DashboardPanel from './DashboardPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DashboardPanel mobile table support', () => {
  it('keeps the market name visible while the top-arbs table scrolls horizontally', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      json: async () => ({
        kpis: { totalArbsFound: 1, activeArbs: 1, totalScans: 1, avgRoi: 1, marketsTracked: 1, totalProfit: 1 },
        scansPerDay: [],
        roiDistribution: [],
        timeline: [],
        topActiveArbs: [{
          id: 1,
          market_id: 'market-1',
          market_title: 'Example market',
          best_roi_pct: 1.5,
          best_profit: 2.5,
          strategy: 'Buy YES Kalshi + NO PM',
          positive_arb_count: 1,
          scanned_at: '2026-07-29T00:00:00.000Z',
        }],
        marketCoverage: [],
        profitTimeline: [],
        lifecycleFunnel: { found: 0, active: 0, recurring: 0, vanished: 0, expired: 0 },
        arbTypeBreakdown: [],
        range: '30d',
      }),
    })));

    render(createElement(DashboardPanel));

    await waitFor(() => expect(screen.getByText('Example market')).toBeTruthy());
    expect(screen.getByTestId('dashboard-top-arbs-scroll').className).toContain('overflow-x-auto');
    expect(document.querySelector('[data-testid="dashboard-top-arbs-scroll"] table')?.className).toContain('min-w-[800px]');
    expect(screen.getByTestId('dashboard-top-arb-market-header').className).toContain('sticky');
    expect(screen.getByTestId('dashboard-top-arb-market-cell').className).toContain('sticky');
  });
});
