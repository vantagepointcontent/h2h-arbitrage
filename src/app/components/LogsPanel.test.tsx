// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import LogsPanel from './LogsPanel';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LogsPanel', () => {
  it('shows invalidated legacy classifications and their audit reason instead of the old arb type', async () => {
    const invalidated = {
      ...comparisonLog(),
      id: 558,
      strategy: 'Same-platform YES+YES Polymarket: Legacy outcome',
      arb_type: null,
      arb_valid: 0,
      arb_invalidation_reason: 'legacy_internal_yes_yes_directional_duplication',
      positive_arb_count: 0,
      best_roi_pct: 0,
      best_profit: 0,
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) {
        return Promise.resolve({ ok: true, json: async () => ({ logs: [invalidated], total: 1 }) });
      }
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    }));

    render(createElement(LogsPanel));

    await waitFor(() => expect(screen.getByText('Invalid arb')).toBeTruthy());
    expect(screen.getByText('Legacy Internal YES+YES duplicates the same directional exposure.')).toBeTruthy();
    expect(screen.queryByText('Internal Arb')).toBeNull();
  });

  it('shows scan ROI, lazy current executable ROI, and Profit in that order', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ ok: true, json: async () => ({ logs: [comparisonLog()], total: 1 }) });
      if (url === '/api/logs/current-roi') {
        expect(JSON.parse(String(init?.body))).toEqual({ ids: [91] });
        return Promise.resolve({ ok: true, json: async () => ({ valuations: [{ id: 91, status: 'available', roiPct: -1.234, strategy: 'Buy YES Kalshi + NO PM', quotedAt: '2026-08-13T20:00:00.000Z' }] }) });
      }
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));

    expect(await screen.findByText('-1.23%')).toBeTruthy();
    const headers = Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent?.trim());
    const roiIndex = headers.findIndex((label) => label?.startsWith('ROI %'));
    expect(headers.slice(roiIndex, roiIndex + 3).map((label) => label?.replace(/[▲▼]/g, '').trim())).toEqual(['ROI %', 'Current ROI %', 'Profit']);
    expect(screen.getByText('-1.23%').className).toContain('text-[#8A9BA8]');
  });

  it.each([
    ['stale_quote', 'Stale quote'],
    ['unavailable_book', 'Book unavailable'],
    ['insufficient_depth', 'Insufficient depth'],
    ['missing_links', 'Missing links'],
    ['upstream_failure', 'Upstream failure'],
  ])('renders current ROI state %s without a fabricated number', async (status, label) => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ ok: true, json: async () => ({ logs: [comparisonLog()], total: 1 }) });
      if (url === '/api/logs/current-roi') return Promise.resolve({ ok: true, json: async () => ({ valuations: [{ id: 91, status }] }) });
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    }));
    render(createElement(LogsPanel));
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.queryByText('0.00%', { selector: 'td' })).toBeNull();
  });

  it('uses the complete non-ROI-filtered dataset maximum for an accessible ROI slider and clamps on filter changes', async () => {
    let searchMaximum = 12.34;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) {
        const params = new URL(url, 'http://localhost').searchParams;
        if (params.get('search')) searchMaximum = 3.21;
        return Promise.resolve({ ok: true, json: async () => ({
          logs: params.get('minRoi') ? [] : [comparisonLog()],
          total: params.get('minRoi') ? 0 : 1,
          maxRoiWithoutMin: searchMaximum,
        }) });
      }
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    const slider = await screen.findByRole('slider', { name: 'Min ROI %' });
    expect(slider).toHaveProperty('min', '0');
    expect(slider).toHaveProperty('max', '12.34');
    expect(screen.getByText('0.00%', { selector: 'output' })).toBeTruthy();

    fireEvent.change(slider, { target: { value: '9.87' } });
    expect(screen.getByText('9.87%')).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => (
      new URL(String(input), 'http://localhost').searchParams.get('minRoi') === '9.87'
    ))).toBe(true));
    expect((screen.getByRole('slider', { name: 'Min ROI %' }) as HTMLInputElement).max).toBe('12.34');

    fireEvent.change(screen.getByRole('textbox', { name: /Search/ }), { target: { value: 'narrow' } });
    await waitFor(() => expect(screen.getByText('3.21%', { selector: 'output' })).toBeTruthy());
    expect((screen.getByRole('slider', { name: 'Min ROI %' }) as HTMLInputElement).value).toBe('3.21');

    fireEvent.click(screen.getByRole('button', { name: 'Reset minimum ROI' }));
    expect(screen.getByText('0.00%', { selector: 'output' })).toBeTruthy();
  });

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
    expect(firstParams.has('maxTteDays')).toBe(false);
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

  it('keeps Preset inline with the filters and applies a single TTE bound to data and export requests', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ ok: true, json: async () => ({
        logs: [comparisonLog()], total: 1, maxRoiWithoutMin: 10,
      }) });
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    const row = screen.getByTestId('logs-segmented-filter-row');
    expect(row.textContent).toContain('Positive arb only');
    expect(row.textContent).toContain('Preset:');
    expect(row.textContent).toContain('Type:');
    expect(row.textContent).toContain('Arb Type:');
    expect(row.textContent).toContain('TTE:');
    expect(row.className).toContain('flex-wrap');
    expect(screen.getByRole('button', { name: 'All TTE' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'TTE under 90 days' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => {
      const url = String(input);
      return url.startsWith('/api/logs?') && new URL(url, 'http://localhost').searchParams.get('maxTteDays') === '90';
    })).toBe(true));
    expect(screen.getByRole('button', { name: 'TTE under 90 days' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('link', { name: 'Export Scan CSV' }).getAttribute('href')).toContain('maxTteDays=90');

    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.getByRole('button', { name: 'All TTE' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => {
      const dataCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/logs?'));
      expect(new URL(String(dataCalls.at(-1)?.[0]), 'http://localhost').searchParams.has('maxTteDays')).toBe(false);
    });
  });

  it('loads one 500-row page per distinct user scroll to the new bottom and deduplicates overlaps', async () => {
    const second = { ...comparisonLog(), id: 92, market_id: 'saved-2', market_name: 'Second market' };
    const third = { ...comparisonLog(), id: 93, market_id: 'saved-3', market_name: 'Third market' };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) {
        const before = new URL(url, 'http://localhost').searchParams.get('before');
        return Promise.resolve({ ok: true, json: async () => before === 'page-2'
          ? { logs: [comparisonLog(), second], total: 3, nextCursor: 'page-3' }
          : before === 'page-3'
            ? { logs: [third], total: 3 }
            : { logs: [comparisonLog()], total: 3, nextCursor: 'page-2' } });
      }
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    const scroller = screen.getByTestId('logs-table-scroll');
    setScrollGeometry(scroller, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByText('Second market')).toBeTruthy());
    fireEvent.scroll(scroller);
    await Promise.resolve();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/logs?'))).toHaveLength(2);
    expect(screen.queryByText('Third market')).toBeNull();

    setScrollGeometry(scroller, { scrollTop: 1100, scrollHeight: 1500, clientHeight: 400 });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByText('Third market')).toBeTruthy());
    expect(screen.getAllByText('Comparison market')).toHaveLength(1);
    const appendLimits = fetchMock.mock.calls
      .filter(([input]) => new URL(String(input), 'http://localhost').searchParams.has('before'))
      .map(([input]) => new URL(String(input), 'http://localhost').searchParams.get('limit'));
    expect(appendLimits).toEqual(['500', '500']);
    expect(screen.queryByRole('button', { name: /Load more/i })).toBeNull();
    expect(screen.getByText('End of results')).toBeTruthy();
  });

  it('resets an in-flight append when search changes and can load the replacement page', async () => {
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
    const scroller = screen.getByTestId('logs-table-scroll');
    setScrollGeometry(scroller, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    fireEvent.scroll(scroller);
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

    setScrollGeometry(scroller, { scrollTop: 1100, scrollHeight: 1500, clientHeight: 400 });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByText('MN-01 second')).toBeTruthy());
    expect(screen.getByText('End of results')).toBeTruthy();
  });

  it.each([
    ['minimum ROI', () => fireEvent.change(screen.getByLabelText('Min ROI %'), { target: { value: '5' } })],
    ['from date', () => fireEvent.change(screen.getByLabelText('From Date'), { target: { value: '2026-08-10T12:00' } })],
    ['to date', () => fireEvent.change(screen.getByLabelText('To Date'), { target: { value: '2026-08-12T12:00' } })],
    ['positive-arb toggle', () => fireEvent.click(screen.getByLabelText('Positive arb only'))],
    ['event type', () => fireEvent.click(screen.getByRole('button', { name: 'Arb' }))],
    ['arb type', () => fireEvent.click(screen.getByRole('button', { name: 'Cross' }))],
    ['TTE', () => fireEvent.click(screen.getByRole('button', { name: 'TTE under 90 days' }))],
    ['preset', () => fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }))],
  ])('synchronously invalidates a pending append and resets virtual scroll for %s changes', async (_label, mutateFilter) => {
    let resolveStalePage!: (value: unknown) => void;
    const stalePage = new Promise((resolve) => { resolveStalePage = resolve; });
    let baseRequests = 0;
    const replacement = { ...comparisonLog(), id: 201, market_name: 'replacement page-one row' };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) {
        const before = new URL(url, 'http://localhost').searchParams.get('before');
        if (before) return stalePage;
        baseRequests += 1;
        return Promise.resolve({ ok: true, json: async () => baseRequests === 1
          ? { logs: Array.from({ length: 250 }, (_, index) => makePagedLog(index)), total: 751, nextCursor: 'old-page-2', maxRoiWithoutMin: 10 }
          : { logs: [replacement], total: 1, maxRoiWithoutMin: 10 } });
      }
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Loaded 250 of 751 entries')).toBeTruthy());
    const scroller = screen.getByTestId('logs-table-scroll');
    setScrollGeometry(scroller, { scrollTop: 8_000, scrollHeight: 9_000, clientHeight: 400 });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes('before=old-page-2'))).toBe(true));

    mutateFilter();
    expect(scroller.scrollTop).toBe(0);
    await waitFor(() => expect(screen.getByText('replacement page-one row')).toBeTruthy());
    expect(screen.queryByText('Loading more results…')).toBeNull();

    resolveStalePage({ ok: true, json: async () => ({
      logs: [{ ...comparisonLog(), id: 999, market_name: 'stale non-search result' }], total: 751,
    }) });
    await Promise.resolve();
    expect(screen.queryByText('stale non-search result')).toBeNull();
  });

  it('keeps rendered table rows bounded while accumulating multiple cursor pages', async () => {
    const pages = [
      Array.from({ length: 250 }, (_, index) => makePagedLog(index)),
      Array.from({ length: 500 }, (_, index) => makePagedLog(250 + index)),
      Array.from({ length: 500 }, (_, index) => makePagedLog(750 + index)),
    ];
    let page = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) {
        const current = page++;
        return Promise.resolve({ ok: true, json: async () => ({ logs: pages[current], total: 1250, nextCursor: current < 2 ? `cursor-${current + 1}` : undefined }) });
      }
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    }));

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Loaded 250 of 1,250 entries')).toBeTruthy());
    const scroller = screen.getByTestId('logs-table-scroll');
    for (const [index, expected] of [750, 1250].entries()) {
      setScrollGeometry(scroller, { scrollTop: 600 + index * 500, scrollHeight: 1000 + index * 500, clientHeight: 400 });
      fireEvent.scroll(scroller);
      await waitFor(() => expect(screen.getByText(`Loaded ${expected.toLocaleString()} of 1,250 entries`)).toBeTruthy());
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
    expect(document.querySelector('table')?.className).toContain('min-w-[1160px]');
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
    const fetchMock = vi.fn((input: RequestInfo | URL, ..._rest: [RequestInit?]) => {
      void _rest;
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ json: async () => ({ logs: [comparisonLog()] }) });
      if (url === '/api/logs/91') return Promise.resolve({ ok: true, json: async () => ({ id: 91, raw_result: comparisonRawResult() }) });
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
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/logs/91')).toHaveLength(1);
  });

  it('fetches expanded details lazily, caches them across collapse, and retries errors', async () => {
    let detailAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ ok: true, json: async () => ({ logs: [comparisonLog()] }) });
      if (url === '/api/logs/91') {
        detailAttempts += 1;
        if (detailAttempts === 1) return Promise.resolve({ ok: false, json: async () => ({ error: 'detail unavailable' }) });
        return Promise.resolve({ ok: true, json: async () => ({ id: 91, raw_result: comparisonRawResult() }) });
      }
      if (url === '/api/logs/current-prices') return Promise.resolve({ ok: true, json: async () => ({ quotes: [] }) });
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/logs/91')).toBe(false);
    fireEvent.click(document.querySelector('tbody tr')!);
    await waitFor(() => expect(screen.getByText('Unable to load scan details.')).toBeTruthy());
    expect(screen.queryByText('No detailed arb data available for this scan.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry scan details' }));
    await waitFor(() => expect(screen.getByText('Arbitrage Opportunities (1)')).toBeTruthy());
    expect(detailAttempts).toBe(2);
    fireEvent.click(document.querySelector('tbody tr')!);
    fireEvent.click(document.querySelector('tbody tr')!);
    await waitFor(() => expect(screen.getByText('Arbitrage Opportunities (1)')).toBeTruthy());
    expect(detailAttempts).toBe(2);
  });

  it('settles one pending detail request after collapse and re-expansion', async () => {
    let resolveDetail!: (value: { ok: boolean; json: () => Promise<{ id: number; raw_result: string }> }) => void;
    const pendingDetail = new Promise<{ ok: boolean; json: () => Promise<{ id: number; raw_result: string }> }>((resolve) => {
      resolveDetail = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ ok: true, json: async () => ({ logs: [comparisonLog()] }) });
      if (url === '/api/logs/91') return pendingDetail;
      if (url === '/api/logs/current-prices') return Promise.resolve({ ok: true, json: async () => ({ quotes: [] }) });
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    const row = document.querySelector('tbody tr')!;
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText('Loading scan details…')).toBeTruthy());
    fireEvent.click(row);
    fireEvent.click(row);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/logs/91')).toHaveLength(1);

    resolveDetail({ ok: true, json: async () => ({ id: 91, raw_result: comparisonRawResult() }) });
    await waitFor(() => expect(screen.getByText('Arbitrage Opportunities (1)')).toBeTruthy());
    expect(screen.queryByText('Loading scan details…')).toBeNull();
  });

  it('caches a successful null detail across collapse and re-expansion', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ ok: true, json: async () => ({ logs: [comparisonLog()] }) });
      if (url === '/api/logs/91') return Promise.resolve({ ok: true, json: async () => ({ id: 91, raw_result: null }) });
      if (url.startsWith('/api/logs/export')) return Promise.resolve({ headers: new Headers() });
      return Promise.resolve({ json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(LogsPanel));
    await waitFor(() => expect(screen.getByText('Comparison market')).toBeTruthy());
    const row = document.querySelector('tbody tr')!;
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText('No detailed arb data available for this scan.')).toBeTruthy());
    fireEvent.click(row);
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText('No detailed arb data available for this scan.')).toBeTruthy());
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/logs/91')).toHaveLength(1);
  });

  it('renders stale and resolved states explicitly without fabricated zero prices', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/logs?')) return Promise.resolve({ json: async () => ({ logs: [comparisonLog()] }) });
      if (url === '/api/logs/91') return Promise.resolve({ ok: true, json: async () => ({ id: 91, raw_result: comparisonRawResult() }) });
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
      if (url === '/api/logs/91') return Promise.resolve({ ok: true, json: async () => ({ id: 91, raw_result: comparisonRawResult() }) });
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

function setScrollGeometry(element: HTMLElement, geometry: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  Object.defineProperties(element, {
    scrollTop: { configurable: true, writable: true, value: geometry.scrollTop },
    scrollHeight: { configurable: true, value: geometry.scrollHeight },
    clientHeight: { configurable: true, value: geometry.clientHeight },
  });
}

function makePagedLog(index: number) {
  return {
    ...comparisonLog(), id: index + 1, market_id: `market-${index + 1}`,
    market_name: `Market ${index + 1}`,
    scanned_at: new Date(Date.parse('2026-08-12T12:00:00.000Z') - index * 1000).toISOString(),
  };
}

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
  };
}

function comparisonRawResult() {
  return JSON.stringify({ allArbs: [{
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
  }] });
}
