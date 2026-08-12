// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DashboardPanel from './DashboardPanel';

const dashboardResponse = {
  kpis: { totalArbsFound: 1, activeArbs: 1, totalScans: 1, avgRoi: 1, marketsTracked: 1, totalProfit: 1 },
  scansPerDay: [],
  roiDistribution: [],
  timeline: [],
  topActiveArbs: [],
  marketCoverage: [],
  profitTimeline: [],
  lifecycleFunnel: { found: 0, active: 0, recurring: 0, vanished: 0, expired: 0 },
  arbTypeBreakdown: [],
  range: '30d',
};

const timingResponse = {
  cells: [{ day: 0, hour: 0, count: 7 }],
  totalEpisodes: 24_633,
  peakCount: 7,
  categories: ['Politics'],
  timeZone: 'America/New_York',
  days: 30,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Opportunity Timing dashboard integration', () => {
  it('loads and renders the complete timing analytics after critical dashboard data', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      const body = url.startsWith('/api/dashboard/arb-timing')
        ? timingResponse
        : url.startsWith('/api/dashboard/stats')
          ? dashboardResponse
          : url.startsWith('/api/arb-lifecycle')
            ? {
                days: 30,
                totals: { episodes: 0, open_now: 0, avg_duration_sec: null, avg_peak_roi: null, max_peak_roi: null, durable_5min: 0, phantom_1min: 0 },
                byCategory: [],
                topDurable: [],
              }
            : { error: 'not available in this test' };
      return { ok: true, json: async () => body } as Response;
    }));

    render(<DashboardPanel />);

    await waitFor(() => expect(screen.getByText('24,633')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'When arbitrage appears' })).toBeTruthy();
    expect(screen.getByRole('grid', { name: /Arbitrage opportunities by weekday and hour/ })).toBeTruthy();
    expect(screen.getByRole('gridcell', { name: /Mon 00:00 US Eastern: 7 episodes/ })).toBeTruthy();
    expect(requestedUrls.filter((url) => url.startsWith('/api/dashboard/arb-timing'))).toHaveLength(1);
  });

  it('keeps Dashboard as the only navigation location for timing analytics', () => {
    const sidebar = readFileSync(`${process.cwd()}/src/app/components/MarketSidebar.tsx`, 'utf8');
    const page = readFileSync(`${process.cwd()}/src/app/page.tsx`, 'utf8');
    const dashboard = readFileSync(`${process.cwd()}/src/app/components/DashboardPanel.tsx`, 'utf8');

    expect(sidebar).not.toContain('label="Arb Timing"');
    expect(sidebar).not.toContain('onGoTiming');
    expect(page).not.toContain('<ArbTimingPanel />');
    expect(page).not.toContain('viewMode === "timing"');
    expect(dashboard).toContain('<ArbTimingPanel />');
  });
});
