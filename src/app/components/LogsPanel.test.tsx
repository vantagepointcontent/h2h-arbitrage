// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import LogsPanel from './LogsPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LogsPanel', () => {
  it('places the APY percentage column immediately after sortable Profit', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/logs')) {
        return Promise.resolve({
          json: async () => ({
            logs: [{
              id: 1,
              market_id: 'market-1',
              best_roi_pct: 2.5,
              best_profit: 12.5,
              strategy: 'Buy YES Kalshi + NO PM',
              outcome_count: 1,
              matched_count: 1,
              kalshi_count: 1,
              pm_count: 1,
              positive_arb_count: 1,
              total_stake: 100,
              scanned_at: '2026-07-26T12:00:00.000Z',
              raw_result: JSON.stringify({ allArbs: [{ apyPct: 23.4 }] }),
            }],
          }),
        });
      }
      return Promise.resolve({ json: async () => [] });
    }));

    render(createElement(LogsPanel));

    await waitFor(() => expect(screen.getByText('APY')).toBeTruthy());
    const headers = Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent?.trim());
    const profitIndex = headers.findIndex((label) => label?.startsWith('Profit'));
    expect(headers[profitIndex + 1]).toBe('APY');
    expect(headers[profitIndex + 1]).not.toContain('x');
    expect(screen.getByTestId('logs-table-scroll').className).toContain('overflow-x-auto');
    expect(document.querySelector('table')?.className).toContain('min-w-[1050px]');
    expect(document.querySelector('thead th')?.className).toContain('sticky');
    expect(document.querySelector('tbody td')?.className).toContain('sticky');
    expect(screen.getByRole('button', { name: 'Refresh' }).className).toContain('min-h-11');
    expect(screen.getByRole('link', { name: 'Export Scan CSV' }).className).toContain('min-h-11');
    expect(screen.getByRole('link', { name: 'Export Trades CSV' }).getAttribute('href')).toBe('/api/logs/trades/export?');
    expect(screen.getByLabelText('Positive arb only').parentElement?.className).toContain('min-h-11');
    expect(screen.getAllByRole('button', { name: /^All$/ }).every((button) => button.className.includes('min-h-11'))).toBe(true);
  });

  it('loads exactly two current leg quotes only on expansion and reuses the brief row cache', async () => {
    let resolveCurrent!: (value: unknown) => void;
    const currentResponse = new Promise((resolve) => { resolveCurrent = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL, _options?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ json: async () => ({ logs: [comparisonLog()] }) });
      if (url === '/api/logs/current-prices') return currentResponse;
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/logs/current-prices')).toHaveLength(0);

    fireEvent.click(document.querySelector('tbody tr')!);
    await waitFor(() => expect(screen.getByText('Loading current executable prices…')).toBeTruthy());
    const currentCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/logs/current-prices');
    expect(currentCall).toBeTruthy();
    expect(JSON.parse(String((currentCall?.[1] as RequestInit).body))).toEqual({ legs: [
      { platform: 'kalshi', marketId: 'KX-EXACT', outcome: 'yes' },
      { platform: 'polymarket', marketId: '0xexact', outcome: 'no' },
    ] });

    resolveCurrent({
      ok: true,
      json: async () => ({ quotes: [
        { platform: 'kalshi', marketId: 'KX-EXACT', outcome: 'yes', status: 'available', priceNow: 0.47, source: 'Executable best ask', quotedAt: '2026-08-11T13:45:00.000Z', stale: false },
        { platform: 'polymarket', marketId: '0xexact', outcome: 'no', status: 'available', priceNow: 0.35, source: 'Executable best ask', quotedAt: '2026-08-11T13:45:00.000Z', stale: false },
      ] }),
    });
    await waitFor(() => expect(screen.getByText('+$0.05 (+11.90%)')).toBeTruthy());
    expect(screen.getByText('−$0.05 (−12.50%)')).toBeTruthy();
    expect(screen.getAllByText('Price then')).toHaveLength(2);
    expect(screen.getAllByText('Price now')).toHaveLength(2);
    expect(screen.getAllByText('Change')).toHaveLength(2);

    fireEvent.click(document.querySelector('tbody tr')!);
    fireEvent.click(document.querySelector('tbody tr')!);
    await waitFor(() => expect(screen.getByText('+$0.05 (+11.90%)')).toBeTruthy());
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/logs/current-prices')).toHaveLength(1);
  });

  it('renders stale and resolved states explicitly without fabricated zero prices', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ json: async () => ({ logs: [comparisonLog()] }) });
      if (url === '/api/logs/current-prices') return Promise.resolve({ ok: true, json: async () => ({ quotes: [
        { platform: 'kalshi', marketId: 'KX-EXACT', outcome: 'yes', status: 'available', priceNow: 0.47, source: 'Executable best ask', quotedAt: '2026-08-11T13:45:00.000Z', stale: true },
        { platform: 'polymarket', marketId: '0xexact', outcome: 'no', status: 'resolved', priceNow: null, source: 'Executable best ask', quotedAt: '2026-08-11T13:45:00.000Z', stale: false },
      ] }) });
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    }));

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    fireEvent.click(document.querySelector('tbody tr')!);
    await waitFor(() => expect(screen.getByText('Stale quote')).toBeTruthy());
    expect(screen.getByText('Resolved market')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('shows rate limiting explicitly', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ json: async () => ({ logs: [comparisonLog()] }) });
      if (url === '/api/logs/current-prices') return Promise.resolve({ ok: false, status: 429, json: async () => ({ error: 'rate limited' }) });
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    }));

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    fireEvent.click(document.querySelector('tbody tr')!);
    await waitFor(() => expect(screen.getByText('Rate limited — current prices unavailable.')).toBeTruthy());
    expect(screen.queryByText('$0.00')).toBeNull();
  });
});

function comparisonLog() {
  return {
    id: 91,
    market_id: 'saved-1',
    market_name: 'Comparison market',
    best_roi_pct: 2.5,
    best_profit: 12.5,
    strategy: 'Buy YES Kalshi + NO PM',
    outcome_count: 1,
    matched_count: 1,
    kalshi_count: 1,
    pm_count: 1,
    positive_arb_count: 1,
    total_stake: 100,
    scanned_at: '2026-08-11T13:42:00.000Z',
    raw_result: JSON.stringify({ allArbs: [{
      artist: 'Outcome A',
      strategy: 'Buy YES Kalshi + NO PM',
      roiPct: 2.5,
      expectedProfit: 12.5,
      kalshiTicker: 'KX-EXACT',
      kalshiYesAsk: 0.42,
      kalshiNoAsk: 0.6,
      pmConditionId: '0xexact',
      pmYesPrice: 0.61,
      pmNoPrice: 0.4,
      pmBestAsk: 0.61,
    }] }),
  };
}
