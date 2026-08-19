// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executableEnvelopeFixture } from '@/lib/test-fixtures/calculation-envelope';
import type { CalculationEnvelope } from '@/lib/calculation-envelope';
import OpenPositionsPanel from './OpenPositionsPanel';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
  Legend: () => null,
  Tooltip: () => null,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const unavailableEnvelope: CalculationEnvelope = {
  ...executableEnvelopeFixture,
  scope: 'position',
  status: 'unavailable',
  blocker: { code: 'account_feed_missing_fee_authority', message: 'Account feed fees are unavailable' },
  executableQuantityMicros: null,
  legs: executableEnvelopeFixture.legs.map((leg) => ({
    ...leg,
    action: 'sell' as const,
    executableQuantityMicros: null,
    fillLevels: [],
    vwapPriceMicros: null,
    fee: { basis: 'unavailable' as const, amountMicros: null, schedule: null },
  })),
  totals: { grossCostMicros: null, grossPayoutMicros: null, grossProfitMicros: null, totalFeesMicros: null, netPnlMicros: null },
};

const chargedEnvelope: CalculationEnvelope = {
  ...executableEnvelopeFixture,
  scope: 'position',
  legs: executableEnvelopeFixture.legs.map((leg, index) => ({
    ...leg,
    action: 'sell' as const,
    fee: {
      basis: 'charged' as const,
      amountMicros: index === 0 ? 15_000 : 7_000,
      schedule: { ...leg.fee.schedule!, source: index === 0 ? 'kalshi-fill-ledger' : 'polymarket-fill-ledger' },
    },
  })),
  totals: { grossCostMicros: 900_000, grossPayoutMicros: 980_000, grossProfitMicros: 80_000, totalFeesMicros: 22_000, netPnlMicros: 58_000 },
};

function position() {
  const unavailableLeg = {
    feesPaid: null, exitFees: null, netPnl: null, roiPct: null,
  };
  return {
    id: 'pair-KXTEST-pm-token', marketTitle: 'Will the test happen?',
    kalshi: {
      platform: 'kalshi', ticker: 'KXTEST', title: 'Will the test happen?', eventTicker: 'KX', side: 'YES',
      position: 1, size: 1, entryPrice: 0.5, currentPrice: 0.61, currentValue: 0.61, totalCost: 0.5,
      unrealizedPnl: 0.11, roiPct: 22, realizedPnl: 0, lastPrice: 0.61,
      feesPaid: null, netUnrealizedPnl: null, netRoiPct: null, exitFees: null,
    },
    polymarket: {
      platform: 'polymarket', asset: 'pm-token', conditionId: 'pm-condition', title: 'Will the test happen?',
      slug: 'test', outcome: 'No', side: 'NO', size: 1, entryPrice: 0.34, currentPrice: 0.35,
      currentValue: 0.35, initialValue: 0.34, cashPnl: 0.01, percentPnl: 2.94, endDate: '2026-12-31T00:00:00Z',
      negativeRisk: false, feesPaid: null, netCashPnl: null, netPercentPnl: null, exitFees: null,
    },
    totalValue: 0.96, totalCost: 0.84, totalUnrealizedPnl: 0.12, totalRoiPct: 14.29,
    breakdown: {
      legA: { platform: 'Kalshi', side: 'YES', entryPrice: 0.5, currentPrice: 0.61, size: 1, grossPnl: 0.11, ...unavailableLeg },
      legB: { platform: 'Polymarket', side: 'NO', entryPrice: 0.34, currentPrice: 0.35, size: 1, grossPnl: 0.01, ...unavailableLeg },
      totalGrossPnl: 0.12, totalFees: null, totalNetPnl: null, totalRoiPct: null,
    },
    pairedState: 'paired', expiry: '2026-12-31T00:00:00Z', netExitValue: null, oneLegExposure: 0,
    exitLiquidityRisk: 'unverified', attentionReasons: ['Net P&L unavailable', 'Exit depth unverified'],
    quoteTimestamps: { kalshi: '2026-08-14T13:00:00Z', polymarket: '2026-08-14T13:00:00Z' },
    calculationEnvelope: unavailableEnvelope,
  };
}

function getResponse() {
  return { success: true, positions: [position()], errors: {}, cash: { kalshi: 10, polymarket: 10, total: 20, complete: true } };
}

describe('OpenPositionsPanel canonical provenance', () => {
  it('renders current unavailable fees without fabricating net values on the responsive surface', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => getResponse() }));
    const { container } = render(<OpenPositionsPanel />);

    expect(await screen.findByText('Account feed fees are unavailable')).toBeTruthy();
    expect(screen.getAllByText('Fee unavailable')).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: /Gross P&L/ })).toBeTruthy();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(4);
    expect(container.querySelector('[data-testid="calculation-provenance"]')?.className).toContain('overflow-x-auto');
  });

  it('shows the server-returned charged early-close envelope and sends only the pair identity', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ action: 'exit', pairId: 'pair-KXTEST-pm-token' });
        return Promise.resolve({ json: async () => ({ success: true, partialFill: false, calculationEnvelope: chargedEnvelope }) });
      }
      return Promise.resolve({ json: async () => getResponse() });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<OpenPositionsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Exit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close both positions' }));

    await waitFor(() => expect(screen.getByText(/Position exit submitted/)).toBeTruthy());
    expect(screen.getAllByText(/Charged exit fee/)).toHaveLength(2);
    expect(screen.getByText(/Canonical net P&L: \$0.06/)).toBeTruthy();
  });
});
