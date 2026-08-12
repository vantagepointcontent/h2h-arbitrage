// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import LogsPanel from './LogsPanel';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LogsPanel', () => {
  it('defaults to rolling 24 hours, positive arbs, 250 rows, and server-side search', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-12T20:15:30.000Z'));
    const fetchMock = vi.fn((input: RequestInfo | URL, ..._rest: [RequestInit?]) => {
      void _rest;
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ ok: true, json: async () => ({
        logs: [comparisonLog()], total: 501, uniqueMarkets: 27,
        summary: { totalArbs: 777, avgRoi: 3.5, bestRoi: 8, totalProfit: 900, arbTypeCounts: { direct: 111, cross: 222, internal: 168 } },
      }) });
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    const firstUrl = String(fetchMock.mock.calls.find(([input]) => String(input).startsWith('/api/logs?'))?.[0]);
    const firstParams = new URL(firstUrl, 'http://localhost').searchParams;
    expect(firstParams.get('limit')).toBe('250');
    expect(firstParams.get('positiveArbOnly')).toBe('true');
    expect(firstParams.get('fromDate')).toBe('2026-08-11T20:15:30.000Z');
    expect(firstParams.get('toDate')).toBe('2026-08-12T20:15:30.000Z');
    expect(screen.getByLabelText('Positive arb only')).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: /Latest 24 hours/ }).getAttribute('title')).toMatch(/rolling 24 hours/i);
    expect(screen.getByText('501')).toBeTruthy();
    expect(screen.getByText('777')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: /Search/ }), { target: { value: 'MN-01' } });
    await vi.advanceTimersByTimeAsync(350);
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => {
      const url = String(input);
      return url.startsWith('/api/logs?') && new URL(url, 'http://localhost').searchParams.get('search') === 'MN-01';
    })).toBe(true));
  });

  it('auto-loads the next cursor page and deduplicates overlapping rows', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    class IntersectionObserverStub {
      constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [];
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
    const second = { ...comparisonLog(), id: 92, market_id: 'saved-2', market_name: 'Second market' };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) {
        const before = new URL(url, 'http://localhost').searchParams.get('before');
        return Promise.resolve({ ok: true, json: async () => before
          ? { logs: [comparisonLog(), second], total: 2 }
          : { logs: [comparisonLog()], total: 2, nextCursor: '2026-08-11T13:42:00.000Z|91' } });
      }
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await waitFor(() => expect(screen.getByText('Second market')).toBeTruthy());
    expect(screen.getAllByText('Comparison market')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Load more/i })).toBeNull();
    expect(screen.getByText('End of results')).toBeTruthy();
  });

  it('resets an in-flight append when search changes and can load the replacement page', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    class IntersectionObserverStub {
      constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [];
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
    let resolveStalePage!: (value: unknown) => void;
    const stalePage = new Promise((resolve) => { resolveStalePage = resolve; });
    const replacementFirst = { ...comparisonLog(), id: 101, market_name: 'MN-01 first' };
    const replacementSecond = { ...comparisonLog(), id: 102, market_name: 'MN-01 second' };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) {
        const params = new URL(url, 'http://localhost').searchParams;
        const before = params.get('before');
        if (!params.get('search')) {
          if (before) return stalePage;
          return Promise.resolve({ ok: true, json: async () => ({ logs: [comparisonLog()], total: 2, nextCursor: 'old|91' }) });
        }
        return Promise.resolve({ ok: true, json: async () => before
          ? { logs: [replacementSecond], total: 2 }
          : { logs: [replacementFirst], total: 2, nextCursor: 'new|101' } });
      }
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    await waitFor(() => expect(intersectionCallback).toBeTypeOf('function'));
    await act(async () => {
      intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => {
      const url = String(input);
      return url.startsWith('/api/logs?') && new URL(url, 'http://localhost').searchParams.get('before') === 'old|91';
    })).toBe(true));

    fireEvent.change(screen.getByRole('textbox', { name: /Search/ }), { target: { value: 'MN-01' } });
    await waitFor(() => expect(screen.getByText('MN-01 first')).toBeTruthy());
    expect(screen.queryByText('Loading more results…')).toBeNull();

    resolveStalePage({ ok: true, json: async () => ({ logs: [{ ...comparisonLog(), id: 999, market_name: 'stale result' }], total: 2 }) });
    await Promise.resolve();
    expect(screen.queryByText('stale result')).toBeNull();

    await act(async () => {
      intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    await waitFor(() => expect(screen.getByText('MN-01 second')).toBeTruthy());
    expect(screen.getByText('End of results')).toBeTruthy();
  });

  it('keeps rendered table rows bounded while accumulating multiple cursor pages', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    class IntersectionObserverStub {
      constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [];
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
    const pages = [0, 250, 500].map((start) => Array.from({ length: 250 }, (_, index) => ({
      ...comparisonLog(), id: start + index + 1, market_id: `market-${start + index + 1}`,
      market_name: `Market ${start + index + 1}`,
      scanned_at: new Date(Date.parse('2026-08-12T12:00:00.000Z') - (start + index) * 1000).toISOString(),
    })));
    let page = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) {
        const current = page++;
        return Promise.resolve({ ok: true, json: async () => ({ logs: pages[current], total: 750, nextCursor: current < 2 ? `cursor-${current + 1}` : undefined }) });
      }
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    }));

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Loaded 250 of 750 entries')).toBeTruthy());
    for (const expected of [500, 750]) {
      await act(async () => {
        intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      await waitFor(() => expect(screen.getByText(`Loaded ${expected} of 750 entries`)).toBeTruthy());
    }

    expect(document.querySelectorAll('tbody tr').length).toBeLessThanOrEqual(102);
    expect(screen.getByTestId('logs-table-scroll').className).toContain('overflow-y-auto');
  });

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
              expiry_at: '2026-08-04T09:13:50.769Z',
              days_to_expiry: 8.884615384,
              apy_pct: 102.7,
              apy_unavailable_reason: null,
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
    expect(screen.getByText('+102.70%')).toBeTruthy();
    expect(screen.queryByText('+23.40%')).toBeNull();
    expect(screen.getByTestId('logs-table-scroll').className).toContain('overflow-x-auto');
    expect(document.querySelector('table')?.className).toContain('min-w-[1050px]');
    expect(document.querySelector('thead th')?.className).toContain('sticky');
    expect(document.querySelector('tbody td')?.className).toContain('sticky');
    expect(screen.getByRole('button', { name: 'Refresh' }).className).toContain('min-h-11');
    expect(screen.getByRole('link', { name: 'Export Scan CSV' }).className).toContain('min-h-11');
    expect(screen.getByRole('link', { name: 'Export Trades CSV' }).getAttribute('href')).toContain('/api/logs/trades/export?fromDate=');
    expect(screen.getByLabelText('Positive arb only').parentElement?.className).toContain('min-h-11');
    expect(screen.getAllByRole('button', { name: /^All$/ }).every((button) => button.className.includes('min-h-11'))).toBe(true);
  });

  it('loads exactly two current leg quotes only on expansion and reuses the brief row cache', async () => {
    let resolveCurrent!: (value: unknown) => void;
    const currentResponse = new Promise((resolve) => { resolveCurrent = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
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
    const body = currentCall?.[1] as { body?: string } | undefined;
    expect(body?.body && JSON.parse(body.body)).toEqual({ legs: [
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
    expiry_at: '2026-08-12T01:42:00.000Z',
    days_to_expiry: 0.5,
    apy_pct: 1825,
    apy_unavailable_reason: null,
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
