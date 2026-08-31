// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BotActionLogs from './BotActionLogs';

describe('BotActionLogs placement filters', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const firstTrade = {
    tradeId: 'trade-1',
    trigger: 'Scan found qualifying arb',
    marketId: 'market-1',
    marketTitle: 'First market',
    startedAt: '2026-08-11T12:00:00.000Z',
    status: 'failed',
    qualified: true,
    steps: [{
      id: 101,
      timestamp: '2026-08-11T12:00:01.000Z',
      step: 'execution',
      action: 'Place both legs',
      responseStatus: 'failed',
      errorReason: 'Polymarket order rejected',
      durationMs: 245,
      requestPayload: { orderId: 'request-1' },
      responsePayload: { accepted: false },
      alertMetadata: { channel: 'telegram' },
      qualificationOutcome: 'qualified',
    }],
  };

  const secondTrade = {
    ...firstTrade,
    tradeId: 'trade-2',
    marketId: 'market-2',
    marketTitle: 'Second market',
    status: 'passed',
    steps: [{ ...firstTrade.steps[0], id: 102, action: 'Second action', responseStatus: 'passed', errorReason: null }],
  };

  const positiveRejectedTrade = {
    ...secondTrade,
    tradeId: 'trade-positive-rejected',
    marketId: 'market-positive-rejected',
    marketTitle: 'Positive arb rejected by ROI gate',
    qualified: false,
    positiveArb: true,
  };

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

  it('defines qualified as positive arb that passed every eligibility gate', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, trades: [], decisions: [] }),
    } as Response);

    render(<BotActionLogs />);

    const definition = screen.getByText('Positive Arb + all eligibility gates passed');
    const checkbox = screen.getByRole('checkbox', { name: 'Qualified only' });
    expect(definition.id).toBe('qualified-only-description');
    expect(checkbox.getAttribute('aria-describedby')).toBe(definition.id);
  });

  it('hides the unqualified result set immediately while a qualified request is pending or fails', async () => {
    const rejectedDecision = {
      scanId: 41,
      logUuid: 'A1B2C3',
      marketId: 'market-2',
      marketName: 'Rejected scan market',
      state: 'rejected',
      reasonCode: 'no_positive_arb',
      reason: 'No Positive Arb — BotTrader not applicable',
      updatedAt: '2026-08-11T12:00:00.000Z',
    };
    let rejectQualifiedRequest: ((reason?: unknown) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, trades: [{ ...secondTrade, qualified: false }], decisions: [rejectedDecision], nextCursor: null }),
      } as Response)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectQualifiedRequest = reject; }));

    render(<BotActionLogs />);
    expect(await screen.findByText('Second market')).toBeTruthy();
    expect(screen.getByText('No Positive Arb — BotTrader not applicable')).toBeTruthy();
    expect(screen.getByText('1 attempts')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Qualified only' }));

    expect(screen.queryByText('Second market')).toBeNull();
    expect(screen.queryByText('No Positive Arb — BotTrader not applicable')).toBeNull();
    expect(screen.getByText('0 attempts')).toBeTruthy();
    await waitFor(() => expect(String(fetchMock.mock.calls[1]?.[0])).toContain('qualified=true'));

    rejectQualifiedRequest?.(new Error('Audit service unavailable'));
    expect((await screen.findByRole('alert')).textContent).toContain('Audit service unavailable');
    expect(screen.queryByText('Second market')).toBeNull();
    expect(screen.queryByText('No Positive Arb — BotTrader not applicable')).toBeNull();
    expect(screen.getByText('0 attempts')).toBeTruthy();
  });

  it('composes qualification with the other filters and restores the full result set', async () => {
    const rejectedDecision = {
      scanId: 41,
      logUuid: 'A1B2C3',
      marketId: 'market-1',
      marketName: 'Rejected scan market',
      state: 'rejected',
      reasonCode: 'no_positive_arb',
      reason: 'No Positive Arb — BotTrader not applicable',
      updatedAt: '2026-08-11T12:00:00.000Z',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const query = new URL(String(input), 'http://localhost').searchParams;
      const qualified = query.get('qualified') === 'true';
      return {
        ok: true,
        json: async () => ({
          success: true,
          trades: qualified ? [firstTrade] : [firstTrade, secondTrade],
          decisions: qualified ? [] : [rejectedDecision],
          nextCursor: null,
        }),
      } as Response;
    });

    render(<BotActionLogs selectionMethod="roi" />);
    expect(await screen.findByText('Second market')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    fireEvent.change(screen.getByLabelText('Since'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByPlaceholderText('All markets'), { target: { value: 'market-1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Qualified only' }));

    expect(await screen.findByText('First market')).toBeTruthy();
    expect(screen.queryByText('Second market')).toBeNull();
    expect(screen.queryByText('No Positive Arb — BotTrader not applicable')).toBeNull();
    expect(screen.getByText('1 attempts')).toBeTruthy();
    expect(screen.getByText('Method: roi')).toBeTruthy();

    const qualifiedUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
    expect(Object.fromEntries(qualifiedUrl.searchParams)).toMatchObject({
      status: 'failed',
      marketId: 'market-1',
      qualified: 'true',
    });
    expect(qualifiedUrl.searchParams.get('since')).toContain('2026-08-01');

    const callsBeforeRefresh = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh action logs' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('qualified=true');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Qualified only' }));
    expect(await screen.findByText('Second market')).toBeTruthy();
    expect(screen.getByText('No Positive Arb — BotTrader not applicable')).toBeTruthy();
    const restoredUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
    expect(restoredUrl.searchParams.has('qualified')).toBe(false);
    expect(Object.fromEntries(restoredUrl.searchParams)).toMatchObject({ status: 'failed', marketId: 'market-1' });
    expect(screen.getByText('Method: roi')).toBeTruthy();
  });

  it('retains the qualified filter during the 30-second auto-refresh callback', async () => {
    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 30_000) intervalCallbacks.push(callback);
      return intervalCallbacks.length as unknown as NodeJS.Timeout;
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, trades: [], decisions: [], nextCursor: null }),
    } as Response);

    render(<BotActionLogs />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Qualified only' }));
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('qualified=true'));
    await waitFor(() => expect(intervalCallbacks.length).toBeGreaterThan(1));

    const callsBeforeTick = fetchMock.mock.calls.length;
    const latestCallback = intervalCallbacks.at(-1);
    if (!latestCallback) throw new Error('Expected auto-refresh callback');
    await act(async () => latestCallback());

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeTick));
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('qualified=true');
  });

  it('immediately removes only non-positive rows and counts while a positive-arb request fails', async () => {
    const noPositiveDecision = {
      scanId: 41,
      logUuid: 'A1B2C3',
      marketId: 'market-no-arb',
      marketName: 'No arb market',
      state: 'criteria_rejected',
      reasonCode: 'no_positive_arb',
      reason: 'No Positive Arb — BotTrader not applicable',
      updatedAt: '2026-08-11T12:00:00.000Z',
    };
    const laterGateDecision = {
      ...noPositiveDecision,
      scanId: 42,
      logUuid: 'D4E5F6',
      marketId: 'market-positive-rejected',
      marketName: 'Positive candidate market',
      reasonCode: 'scan_criteria_rejected',
      reason: 'Positive candidate missed the ROI threshold',
    };
    let rejectPositiveRequest: ((reason?: unknown) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          trades: [positiveRejectedTrade, { ...secondTrade, marketTitle: 'Legacy unclassified row', positiveArb: false }],
          decisions: [noPositiveDecision, laterGateDecision],
          nextCursor: 101,
        }),
      } as Response)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPositiveRequest = reject; }));

    render(<BotActionLogs />);
    expect(await screen.findByText('Legacy unclassified row')).toBeTruthy();
    expect(screen.getByText('No Positive Arb — BotTrader not applicable')).toBeTruthy();
    expect(screen.getByText('2 attempts')).toBeTruthy();
    expect(screen.getByText('2 runs')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Positive arb only' }));

    expect(screen.queryByText('Legacy unclassified row')).toBeNull();
    expect(screen.queryByText('No Positive Arb — BotTrader not applicable')).toBeNull();
    expect(screen.getByText('Positive arb rejected by ROI gate')).toBeTruthy();
    expect(screen.getByText('Positive candidate missed the ROI threshold')).toBeTruthy();
    expect(screen.getByText('1 attempts')).toBeTruthy();
    expect(screen.getByText('1 runs')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load older action logs' })).toBeNull();
    await waitFor(() => expect(String(fetchMock.mock.calls[1]?.[0])).toContain('positiveArb=true'));

    rejectPositiveRequest?.(new Error('Filtered audit unavailable'));
    expect((await screen.findByRole('alert')).textContent).toContain('Filtered audit unavailable');
    expect(screen.queryByText('Legacy unclassified row')).toBeNull();
    expect(screen.queryByText('No Positive Arb — BotTrader not applicable')).toBeNull();
    expect(screen.getByText('1 attempts')).toBeTruthy();
    expect(screen.getByText('1 runs')).toBeTruthy();
  });

  it('composes positive arb with qualification and keeps it through refresh and auto-refresh', async () => {
    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 30_000) intervalCallbacks.push(callback);
      return intervalCallbacks.length as unknown as NodeJS.Timeout;
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, trades: [positiveRejectedTrade], decisions: [], nextCursor: null }),
    } as Response);

    render(<BotActionLogs selectionMethod="apy" />);
    await screen.findByText('Positive arb rejected by ROI gate');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    fireEvent.change(screen.getByLabelText('Since'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByPlaceholderText('All markets'), { target: { value: 'market-positive-rejected' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Positive arb only' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Qualified only' }));

    await waitFor(() => {
      const url = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        positiveArb: 'true',
        qualified: 'true',
        status: 'failed',
        marketId: 'market-positive-rejected',
      });
      expect(url.searchParams.get('since')).toContain('2026-08-01');
    });
    expect(screen.getByText('Method: apy')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh action logs' }));
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('positiveArb=true'));
    const latestCallback = intervalCallbacks.at(-1);
    if (!latestCallback) throw new Error('Expected positive-arb auto-refresh callback');
    await act(async () => latestCallback());
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('positiveArb=true'));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Qualified only' }));
    await waitFor(() => {
      const url = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
      expect(url.searchParams.get('positiveArb')).toBe('true');
      expect(url.searchParams.has('qualified')).toBe(false);
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Positive arb only' }));
    await waitFor(() => expect(new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost').searchParams.has('positiveArb')).toBe(false));
  });

  it('shows a row-reconcilable reason for every persisted scan decision', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        trades: [],
        decisions: [{
          scanId: 41,
          logUuid: 'A1B2C3',
          marketId: 'market-41',
          marketName: 'Test Market',
          state: 'revalidation_rejected',
          reasonCode: 'current_quote_stale',
          reason: 'Current executable quote is stale',
          updatedAt: '2026-08-11T12:00:10.000Z',
        }],
      }),
    } as Response);
    render(<BotActionLogs />);
    const scanId = await screen.findByText('Scan #41');
    expect(scanId.parentElement?.textContent).toBe('Scan #41·A1B2C3·Test Market·current_quote_stale');
    expect(screen.getByText('Current executable quote is stale')).toBeTruthy();
    expect(screen.getAllByText('current_quote_stale')).toHaveLength(2);
    expect(screen.getByText('A1B2C3')).toBeTruthy();
    expect(screen.getAllByText('Test Market')).toHaveLength(2);
    expect(scanId.closest('button')?.getAttribute('aria-label')).toContain('reason code current_quote_stale');
  });

  it('restores separate scan-run, market, and stage hierarchy while preserving audit fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        trades: [firstTrade],
        decisions: [{
          scanId: 41,
          logUuid: 'A1B2C3',
          marketId: 'market-41',
          marketName: 'Test Market',
          source: 'scan_api',
          state: 'revalidation_rejected',
          reasonCode: 'current_quote_stale',
          reason: 'Current executable quote is stale',
          receivedAt: '2026-08-11T12:00:00.000Z',
          updatedAt: '2026-08-11T12:00:10.000Z',
          attempts: 1,
          placementCount: 0,
          details: { retryable: true },
        }],
        nextCursor: null,
      }),
    } as Response);

    render(<BotActionLogs selectionMethod="roi" />);

    expect(await screen.findByRole('heading', { name: 'Scan runs' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Market opportunities' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Expand scan 41,/ }));
    const scanDetails = screen.getByTestId('scan-details-41');
    expect(within(scanDetails).getByText('Current executable quote is stale')).toBeTruthy();
    expect(within(scanDetails).getByText('scan_api')).toBeTruthy();
    expect(within(scanDetails).getByText('1 attempt')).toBeTruthy();
    expect(within(scanDetails).getByText('0 placements')).toBeTruthy();
    expect(within(scanDetails).getByText(/"retryable": true/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Expand attempt for First market,/ }));
    const attempt = screen.getByTestId('attempt-details-trade-1');
    expect(within(attempt).getByRole('heading', { name: 'Execution' })).toBeTruthy();
    expect(within(attempt).getByText('Polymarket order rejected')).toBeTruthy();
    expect(within(attempt).getByText(/245 ms/)).toBeTruthy();
    expect(within(attempt).getByText('Qualified')).toBeTruthy();
    fireEvent.click(within(attempt).getByText('Request / response / alert'));
    expect(within(attempt).getByText(/"orderId": "request-1"/)).toBeTruthy();
    expect(within(attempt).getByText(/"accepted": false/)).toBeTruthy();
    expect(within(attempt).getByText(/"channel": "telegram"/)).toBeTruthy();
  });

  it('keeps scan and market expansion independent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        trades: [firstTrade, secondTrade],
        decisions: [{ scanId: 41, state: 'failed', reasonCode: 'failed', reason: 'Failed', updatedAt: '2026-08-11T12:00:10.000Z' }],
        nextCursor: null,
      }),
    } as Response);

    render(<BotActionLogs />);
    await screen.findByText('First market');
    fireEvent.click(screen.getByRole('button', { name: /^Expand scan 41,/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Expand attempt for First market,/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Expand attempt for Second market,/ }));
    expect(screen.getByTestId('scan-details-41')).toBeTruthy();
    expect(screen.getByTestId('attempt-details-trade-1')).toBeTruthy();
    expect(screen.getByTestId('attempt-details-trade-2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Collapse attempt for First market,/ }));
    expect(screen.queryByTestId('attempt-details-trade-1')).toBeNull();
    expect(screen.getByTestId('attempt-details-trade-2')).toBeTruthy();
    expect(screen.getByTestId('scan-details-41')).toBeTruthy();
  });

  it('merges cursor pages without duplicating a trade or its events', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, trades: [firstTrade], decisions: [], nextCursor: 101 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          trades: [{
            ...firstTrade,
            marketTitle: 'Stale market title',
            steps: [
              { ...firstTrade.steps[0], action: 'Stale duplicate action' },
              { ...firstTrade.steps[0], id: 99, action: 'Older action' },
            ],
          }],
          decisions: [],
          nextCursor: null,
        }),
      } as Response);

    render(<BotActionLogs />);
    await screen.findByText('First market');
    fireEvent.click(screen.getByRole('button', { name: 'Load older action logs' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('First market')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^Expand attempt for First market,/ }));
    expect(screen.getAllByText('Place both legs')).toHaveLength(1);
    expect(screen.queryByText('Stale duplicate action')).toBeNull();
    expect(screen.queryByText('Stale market title')).toBeNull();
    expect(screen.getByText('Older action')).toBeTruthy();
  });

  it('renders loading and error states without replacing the last successful data', async () => {
    let rejectRequest: ((reason?: unknown) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, trades: [firstTrade], decisions: [], nextCursor: null }),
      } as Response)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));

    render(<BotActionLogs />);
    expect(await screen.findByText('First market')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh action logs' }));
    expect(screen.getByRole('status').textContent).toContain('Refreshing logs');
    expect(screen.getByText('First market')).toBeTruthy();
    rejectRequest?.(new Error('Audit service unavailable'));
    expect((await screen.findByRole('alert')).textContent).toContain('Audit service unavailable');
    expect(screen.getByText('First market')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts pending requests when the view unmounts', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    });

    const view = render(<BotActionLogs />);
    await waitFor(() => expect(requestSignal).toBeTruthy());
    expect(requestSignal?.aborted).toBe(false);
    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('ignores an aborted old cursor page after a newer refresh', async () => {
    let resolveOldPage: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, trades: [firstTrade], decisions: [], nextCursor: 101 }),
      } as Response)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldPage = resolve; }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, trades: [secondTrade], decisions: [], nextCursor: 201 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, trades: [], decisions: [], nextCursor: null }),
      } as Response);

    render(<BotActionLogs />);
    await screen.findByText('First market');
    fireEvent.click(screen.getByRole('button', { name: 'Load older action logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh action logs' }));
    expect(await screen.findByText('Second market')).toBeTruthy();

    resolveOldPage?.({
      ok: true,
      json: async () => ({ success: true, trades: [{ ...firstTrade, steps: [{ ...firstTrade.steps[0], id: 99, action: 'Stale old event' }] }], decisions: [], nextCursor: null }),
    } as Response);
    await waitFor(() => expect(screen.queryByText('First market')).toBeNull());
    expect(screen.queryByText('Stale old event')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load older action logs' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('cursor=201');
  });

  it('invalidates the old cursor synchronously when filters change', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, trades: [firstTrade], decisions: [], nextCursor: 101 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, trades: [], decisions: [], nextCursor: null }),
      } as Response);

    render(<BotActionLogs />);
    await screen.findByText('First market');
    const oldCursorButton = screen.getByRole('button', { name: 'Load older action logs' });
    fireEvent.change(screen.getByPlaceholderText('All markets'), { target: { value: 'market-2' } });
    fireEvent.click(oldCursorButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('marketId=market-2');
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain('cursor=101');
  });
});