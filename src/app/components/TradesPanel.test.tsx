// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

async function renderHistory(executions: unknown[]) {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('/api/executions')) return response({ success: true, executions });
    if (url === '/api/closed-positions?limit=500') return response({ success: true, positions: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }));

  render(<TradesPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  await waitFor(() => expect(screen.queryByText('Loading trades…')).toBeNull());
}

describe('TradesPanel canonical execution history', () => {
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
