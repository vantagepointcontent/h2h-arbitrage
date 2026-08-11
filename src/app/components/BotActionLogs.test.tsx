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

  it('clearly labels failed and pending placement attempts separately from positions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, trades: [
        {
          tradeId: 'failed-1', trigger: 'scan', marketId: 'm1', marketTitle: 'Rejected market',
          startedAt: '2026-08-10T12:00:00.000Z', status: 'failed', qualified: true,
          steps: [{ id: 1, timestamp: '2026-08-10T12:00:00.000Z', step: 'execution', action: 'Place both legs', responseStatus: 'failed', errorReason: 'Kalshi rejected order', durationMs: 90, requestPayload: null, responsePayload: null, alertMetadata: null }],
        },
        {
          tradeId: 'pending-1', trigger: 'scan', marketId: 'm2', marketTitle: 'Partial market',
          startedAt: '2026-08-10T12:01:00.000Z', status: 'pending', qualified: true,
          steps: [{ id: 2, timestamp: '2026-08-10T12:01:00.000Z', step: 'execution', action: 'Await Polymarket fill', responseStatus: 'pending', errorReason: null, durationMs: null, requestPayload: null, responsePayload: null, alertMetadata: null }],
        },
      ] }),
    } as Response);

    render(<BotActionLogs />);
    expect(await screen.findByText('Rejected / failed')).toBeTruthy();
    expect(screen.getByText('Placement in progress / partial')).toBeTruthy();
    expect(screen.getAllByText(/Attempt only — not an open position/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Expand attempt for Rejected market/ }));
    expect(screen.getByText('Kalshi rejected order')).toBeTruthy();
  });
});