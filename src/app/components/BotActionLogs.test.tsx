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
});