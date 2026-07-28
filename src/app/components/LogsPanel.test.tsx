// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  });
});
