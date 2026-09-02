// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCalculationEnvelope } from '@/lib/calculation-envelope';
import { executableEnvelopeFixture } from '@/lib/test-fixtures/calculation-envelope';
import TradesPanel from './TradesPanel';

vi.mock('next/dynamic', () => ({
  default: () => function MockOpenPositionsPanel() {
    return <div>Open positions</div>;
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function execution(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    timestamp: '2026-08-14T13:00:00.000Z',
    arbId: 'arb-1',
    marketTitle: 'Canonical history probe',
    dryRun: false,
    success: true,
    kalshiOrder: { ticker: 'KXTEST', outcome: 'YES', side: 'sell', size: 1, price: 0.61 },
    polymarketOrder: { conditionId: 'pm-test', outcome: 'NO', side: 'sell', size: 1, price: 0.35 },
    result: {
      kalshiResult: { status: 'filled', orderId: 'k-1', filledSize: 1 },
      polymarketResult: { status: 'filled', orderId: 'p-1', filledSize: 1 },
    },
    estimatedProfit: 123.45,
    ...overrides,
  };
}

function response(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response);
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve: (body: unknown) => resolve({ ok: true, json: async () => body } as Response) };
}

function executionSummary(executions: unknown[]) {
  type TestExecution = {
    id: number;
    calculationEnvelope?: unknown;
    dryRun: boolean;
    success: boolean;
    result?: {
      kalshiResult?: { status?: string };
      polymarketResult?: { status?: string };
      unhedged?: boolean;
      netExposure?: number;
    } | null;
  };
  const rows = executions as TestExecution[];
  const canonicalPnl = (row: TestExecution) => {
    const envelope = parseCalculationEnvelope(row.calculationEnvelope, `execution ${row.id}`);
    return envelope.scope === 'execution'
      && envelope.status === 'executable'
      && envelope.legs.length === 2
      && envelope.legs.every((leg) => leg.action === 'buy')
      ? envelope.totals.netPnlMicros
      : null;
  };
  const realPnls = rows.filter((row) => !row.dryRun && row.success).map(canonicalPnl).filter((pnl): pnl is number => pnl != null);
  const pendingCount = rows.filter((row) => {
    if (!row.success || row.dryRun || canonicalPnl(row) == null) return false;
    return row.result?.kalshiResult?.status === 'pending' || row.result?.polymarketResult?.status === 'pending';
  }).length;
  const unhedged = rows.filter((row) => row.result?.unhedged);
  return {
    realCount: realPnls.length,
    pendingCount,
    totalNetPnlMicros: realPnls.length > 0 ? realPnls.reduce((sum, pnl) => sum + pnl, 0) : null,
    unhedgedCount: unhedged.length,
    unhedgedExposure: unhedged.reduce((sum, row) => sum + (row.result?.netExposure ?? 0), 0),
  };
}

async function renderHistory(executions: unknown[]) {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('/api/executions')) return response({
      success: true,
      executions,
      total: executions.length,
      sourceCounts: {
        all: executions.length,
        manual: executions.filter((item) => (item as { source?: string }).source === 'manual').length,
        bot: executions.filter((item) => (item as { source?: string }).source === 'bot').length,
        unknown: executions.filter((item) => (item as { source?: string }).source === 'unknown').length,
      },
      summary: executionSummary(executions),
      nextOffset: null,
    });
    if (url === '/api/closed-positions?limit=500') return response({ success: true, positions: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }));

  render(<TradesPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  await waitFor(() => expect(screen.queryByText('Loading trades…')).toBeNull());
}

describe('TradesPanel canonical execution history', () => {
  it('offers server-backed Manual, BotTrader, and Unknown source views without coupling source to paper/live mode', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/closed-positions?limit=500') return response({ success: true, positions: [] });
      if (url.startsWith('/api/executions')) {
        const source = new URL(url, 'http://localhost').searchParams.get('source');
        const rows = source === 'manual'
          ? [execution({ id: 1, source: 'manual', dryRun: true, marketTitle: 'Manual paper trade' })]
          : source === 'bot'
            ? [execution({ id: 2, source: 'bot', dryRun: true, marketTitle: 'Bot paper trade' })]
            : source === 'unknown'
              ? [execution({ id: 3, source: 'unknown', dryRun: false, marketTitle: 'Unknown live trade' })]
              : [];
        return response({
          success: true,
          executions: rows,
          total: rows.length,
          sourceCounts: { all: 3, manual: 1, bot: 1, unknown: 1 },
          nextOffset: null,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TradesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Manual trades.*1/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Manual trades.*1/ }));
    await waitFor(() => expect(screen.getByText('Manual paper trade')).toBeTruthy());
    expect(screen.queryByText('Bot paper trade')).toBeNull();
    expect(screen.queryByText('Closed positions')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /BotTrader trades.*1/ }));
    await waitFor(() => expect(screen.getByText('Bot paper trade')).toBeTruthy());
    expect(screen.queryByText('Manual paper trade')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Unknown source.*1/ }));
    await waitFor(() => expect(screen.getByText('Unknown live trade')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('source=unknown'), { cache: 'no-store' });
  });

  it('does not let a slower previous source view overwrite a newer Manual view', async () => {
    const all = deferredResponse();
    const manual = deferredResponse();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/closed-positions?limit=500') return response({ success: true, positions: [] });
      if (url.includes('source=manual')) return manual.promise;
      if (url.startsWith('/api/executions')) return all.promise;
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<TradesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual trades/ }));
    manual.resolve({
      success: true,
      executions: [execution({ id: 2, source: 'manual', marketTitle: 'Newest manual view' })],
      total: 1,
      sourceCounts: { all: 2, manual: 1, bot: 1, unknown: 0 },
      nextOffset: null,
    });
    await waitFor(() => expect(screen.getByText('Newest manual view')).toBeTruthy());

    await act(async () => {
      all.resolve({
        success: true,
        executions: [execution({ id: 1, source: 'bot', marketTitle: 'Stale all view' })],
        total: 1,
        sourceCounts: { all: 2, manual: 1, bot: 1, unknown: 0 },
        nextOffset: null,
      });
      await all.promise;
    });
    expect(screen.getByText('Newest manual view')).toBeTruthy();
    expect(screen.queryByText('Stale all view')).toBeNull();
  });

  it('keeps the current page and cursor when the active source tab is clicked again', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/closed-positions?limit=500') return response({ success: true, positions: [] });
      if (url.startsWith('/api/executions')) return response({
        success: true,
        executions: [execution({ source: 'manual', marketTitle: 'First page trade' })],
        total: 501,
        sourceCounts: { all: 501, manual: 501, bot: 0, unknown: 0 },
        nextOffset: 500,
      });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TradesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Load more \(1 of 501\)/ })).toBeTruthy());
    const executionRequestsBeforeClick = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/executions')).length;

    fireEvent.click(screen.getByRole('button', { name: /All trades.*501/ }));

    expect(screen.getByRole('button', { name: /Load more \(1 of 501\)/ })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/executions'))).toHaveLength(executionRequestsBeforeClick);
  });

  it('lets the active source request finish when its tab is clicked while loading', async () => {
    const all = deferredResponse();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/closed-positions?limit=500') return response({ success: true, positions: [] });
      if (url.startsWith('/api/executions')) return all.promise;
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<TradesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: /All trades/ }));
    await act(async () => {
      all.resolve({
        success: true,
        executions: [execution({ source: 'manual', marketTitle: 'Completed active request' })],
        total: 1,
        sourceCounts: { all: 1, manual: 1, bot: 0, unknown: 0 },
        nextOffset: null,
      });
      await all.promise;
    });

    await waitFor(() => expect(screen.getByText('Completed active request')).toBeTruthy());
    expect(screen.queryByText('Loading trades…')).toBeNull();
  });

  it('does not promote unavailable live success or its legacy estimate to real filled P&L', async () => {
    await renderHistory([execution({
      result: {
        kalshiResult: { status: 'filled', orderId: 'k-1', filledSize: 1 },
        polymarketResult: { status: 'filled', orderId: 'p-1', filledSize: 1 },
        actualProfit: 456.78,
        steps: [{ timestamp: '2026-08-14T13:00:01.000Z', status: 'success', description: 'Venue acknowledged' }],
      },
      calculationEnvelope: {
        ...executableEnvelopeFixture,
        scope: 'execution',
        status: 'unavailable',
        blocker: { code: 'missing_exit_evidence', message: 'One leg lacks fill evidence' },
        executableQuantityMicros: null,
        totals: {
          grossCostMicros: null,
          grossPayoutMicros: null,
          grossProfitMicros: null,
          totalFeesMicros: null,
          netPnlMicros: null,
        },
      },
    })]);

    expect(screen.getByText('Canonical history probe')).toBeTruthy();
    expect(screen.getByText('unavailable')).toBeTruthy();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('$123.45')).toBeNull();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(within(screen.getByText('Real (verified)').parentElement!).getByText('0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand trade details' }));
    expect(screen.getByText('Actual P&L:')).toBeTruthy();
    expect(screen.queryByText('$456.78')).toBeNull();
  });

  it('renders and sums only net P&L from a validated executable envelope', async () => {
    await renderHistory([execution({
      estimatedProfit: 999,
      calculationEnvelope: { ...executableEnvelopeFixture, scope: 'execution' },
    })]);

    expect(screen.getByText('filled')).toBeTruthy();
    expect(within(screen.getByText('Real (verified)').parentElement!).getByText('1')).toBeTruthy();
    expect(screen.getAllByText('-$0.01')).toHaveLength(2);
    expect(screen.queryByText('$999.00')).toBeNull();
  });

  it('keeps legacy, malformed, and economically forged calculation envelopes visibly unavailable', async () => {
    const forgedEnvelope = {
      ...executableEnvelopeFixture,
      scope: 'execution',
      totals: {
        ...executableEnvelopeFixture.totals,
        grossCostMicros: 1,
        grossPayoutMicros: 1_000_000_001,
        grossProfitMicros: 1_000_000_000,
        netPnlMicros: 999_971_440,
      },
    };
    const forgedSellEnvelope = {
      ...executableEnvelopeFixture,
      scope: 'execution',
      legs: executableEnvelopeFixture.legs.map((leg) => ({ ...leg, action: 'sell' })),
      totals: {
        ...executableEnvelopeFixture.totals,
        grossCostMicros: 1,
        grossPayoutMicros: 980_000,
        grossProfitMicros: 979_999,
        netPnlMicros: 951_439,
      },
    };
    await renderHistory([
      execution({ id: 1, marketTitle: 'Legacy row', calculationEnvelope: undefined, estimatedProfit: 77 }),
      execution({ id: 2, marketTitle: 'Malformed row', calculationEnvelope: '{not-json', estimatedProfit: -88 }),
      execution({ id: 3, marketTitle: 'Forged row', calculationEnvelope: forgedEnvelope, estimatedProfit: 999.97144 }),
      execution({ id: 4, marketTitle: 'Forged sell row', calculationEnvelope: forgedSellEnvelope, estimatedProfit: 951.439 }),
    ]);

    expect(screen.getAllByText('unavailable')).toHaveLength(4);
    expect(screen.queryByText('$77.00')).toBeNull();
    expect(screen.queryByText('$-88.00')).toBeNull();
    expect(screen.queryByText('$999.97')).toBeNull();
    expect(screen.queryByText('$951.44')).toBeNull();
    expect(screen.queryByText('$0.00')).toBeNull();
  });
});
