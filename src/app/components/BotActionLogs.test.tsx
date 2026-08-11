// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BotActionLogs from './BotActionLogs';

describe('BotActionLogs qualified-only filter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requests server-side qualified chains and shows the dedicated empty state', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, trades: [] }),
    } as Response);
    render(<BotActionLogs />);
    const toggle = screen.getByRole('checkbox', { name: 'Qualified only' });
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('qualified=true'))).toBe(true));
    expect(await screen.findByText('No qualifying evaluations in the selected period.')).toBeTruthy();
  });

  it('shows a row-reconcilable reason for every persisted scan decision', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        trades: [],
        decisions: [{
          scanId: 41,
          marketTitle: 'Test Market',
          state: 'revalidation_rejected',
          reasonCode: 'current_quote_stale',
          reason: 'Current executable quote is stale',
          updatedAt: '2026-08-11T12:00:10.000Z',
        }],
      }),
    } as Response);
    render(<BotActionLogs />);
    expect(await screen.findByText('Scan #41')).toBeTruthy();
    expect(screen.getByText('Current executable quote is stale')).toBeTruthy();
    expect(screen.getByText('current_quote_stale')).toBeTruthy();
  });
});