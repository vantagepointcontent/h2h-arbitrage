// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BotTraderPanel, { positionRoiBps } from './BotTraderPanel';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Legend: () => null,
  Bar: () => null,
}));

const analytics = {
  totalBotTrades: { paper: 47, production: 3, total: 50 },
  openPositions: { count: 12, unrealizedPnlCents: 1234 },
  settledPositions: { count: 19, realizedPnlCents: 567, winRateBps: 6842 },
  averageRoi: { atTradeBps: 240, currentBps: 190 },
  bestTrade: null,
  worstTrade: null,
  dailyPnl: [],
  timeStats: { tradesPerDayBps: 10000, averageHoldSeconds: 0 },
  performance: {
    positionIds: [1],
    capital: { deployedCents: 97, currentCents: 102, heldToResolutionCents: 100 },
    entryCost: { available: 1, unavailable: 0 },
    pnl: { realizedCents: 0, unrealizedCents: 5, totalCents: 5, roiBps: 515 },
    valuation: { fresh: 1, stale: 0, unavailable: 0, pendingSettlement: 0, asOf: '2026-08-11T13:40:00.000Z' },
    entryCohorts: [{ date: '2026-08-08', deployedCents: 97, currentCents: 102, heldToResolutionCents: 100, realizedCents: 0, unrealizedCents: 5, trades: 1 }],
  },
};

const positions = [{
  id: 1,
  executionId: 9,
  marketId: 'market-1',
  marketTitle: 'Trump 2026',
  kalshiTicker: 'KXTRUMP-26',
  pmConditionId: '0xabc',
  kalshiUrl: 'https://kalshi.com/markets/kxtrump-26',
  polymarketUrl: 'https://polymarket.com/event/trump-2026',
  strategy: 'Buy YES K + NO PM',
  kalshiSide: 'yes',
  pmSide: 'no',
  buyPriceKalshiCents: 45,
  buyPricePmCents: 52,
  sharesKalshi: 1,
  sharesPm: 1,
  totalCostCents: 97,
  entryCostStatus: 'available',
  entryCostFailureReason: null,
  kalshiEntryGrossMicrocents: 45_000_000,
  pmEntryGrossMicrocents: 52_000_000,
  kalshiEntryFeeCents: 0,
  pmEntryFeeCents: 0,
  entryCostRoundingDeltaMicrocents: 0,
  kalshiEntryFillCount: 1,
  pmEntryFillCount: 1,
  expectedPayoutCents: 100,
  expectedProfitCents: 3,
  feesCents: 0,
  status: 'open',
  openedAt: '2026-08-08T16:00:00.000Z',
  expiryDate: '2026-12-31T00:00:00.000Z',
  settledAt: null,
  currentPriceKalshiCents: 48,
  currentPricePmCents: 54,
  currentValueCents: 102,
  kalshiGrossProceedsMicrocents: 48_000_000,
  pmGrossProceedsMicrocents: 54_000_000,
  kalshiNetProceedsCents: 48,
  pmNetProceedsCents: 54,
  kalshiExitFeeCents: 0,
  pmExitFeeCents: 0,
  kalshiExitFeeType: 'quadratic',
  kalshiExitFeeMultiplierPpm: 1_000_000,
  pmExitFeeRateBps: 400,
  // Deliberately inconsistent legacy fields: the table must derive these from
  // currentValueCents and totalCostCents instead of trusting stale mappings.
  unrealizedPnlCents: 97,
  unrealizedRoiBps: 9999,
  lastValuationAt: '2026-08-11T13:40:00.000Z',
  realizedPnlCents: null,
  settlementSide: null,
  dryRun: true,
}];

function response(data: unknown, ok = true) {
  return Promise.resolve({ ok, json: async () => data });
}

function stubInitialFetch() {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/analytics')) return response({ success: true, analytics: url.includes('mode=production') ? {
      ...analytics,
      positions: [],
      totalBotTrades: { paper: 0, production: 0, total: 0 },
      openPositions: { count: 0, unrealizedPnlCents: 0 },
      settledPositions: { count: 0, realizedPnlCents: 0, winRateBps: 0 },
      performance: {
        positionIds: [],
        capital: { deployedCents: 0, currentCents: 0, heldToResolutionCents: 0 },
        pnl: { realizedCents: 0, unrealizedCents: 0, totalCents: 0, roiBps: null },
        valuation: { fresh: 0, stale: 0, unavailable: 0, pendingSettlement: 0, asOf: null },
        entryCohorts: [],
      },
    } : { ...analytics, positions } });
    if (url.includes('/positions')) return response({ success: true, positions });
    if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
    throw new Error(`Unexpected fetch: ${url}`);
  }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BotTraderPanel', () => {
  it('shows a dedicated loading state while the verified performance snapshot is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<BotTraderPanel />);
    expect(screen.getByText('Loading BotTrader analytics…')).toBeTruthy();
  });

  it('shows a retryable full error state when the performance query fails', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: false, error: 'Analytics unavailable' }, false);
      if (url.includes('/positions')) return response({ success: true, positions: [] });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);
    expect((await screen.findByRole('alert')).textContent).toContain('Analytics unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('queries BotTrader-only analytics with explicit mode, method, and Dashboard range semantics', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);
    await screen.findByText('Trump 2026');

    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/bot-trader/analytics?method=all&mode=paper&range=30d')).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Performance method' }), { target: { value: 'roi' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '7 Days' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '7 Days' }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/bot-trader/analytics?method=roi&mode=paper&range=7d')).toBe(true));
  });

  it('keeps an already-active filter idempotent instead of entering a stuck loading state', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);
    await screen.findByText('Trump 2026');
    const callsBefore = vi.mocked(fetch).mock.calls.length;

    fireEvent.change(screen.getByRole('combobox', { name: 'Performance method' }), { target: { value: 'all' } });

    expect(screen.queryByText('Loading BotTrader analytics…')).toBeNull();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(callsBefore);
  });

  it('renders fee-inclusive performance cards and executable quote freshness from one analytics response', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);

    await screen.findByText('Trump 2026');
    expect(screen.getByText('Deployed').parentElement?.textContent).toBe('Deployed$0.97');
    expect(screen.getByText('Executable value').parentElement?.textContent).toBe('Executable value$1.02');
    expect(screen.getByText('Held to resolution').parentElement?.textContent).toBe('Held to resolution$1.00');
    expect(screen.getByText('Portfolio ROI').parentElement?.textContent).toBe('Portfolio ROI+5.2%');
    expect(screen.getByText(/Executable quotes fresh for 1 open position/)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'BotTrader current performance by entry date chart' })).toBeTruthy();
  });

  it('renders partial valuation and range-specific empty states without misleading P&L', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: {
        ...analytics,
        positions: [],
        totalBotTrades: { paper: 1, production: 0, total: 1 },
        performance: {
          positionIds: [],
          capital: { deployedCents: 97, currentCents: null, heldToResolutionCents: 100 },
          pnl: { realizedCents: 0, unrealizedCents: null, totalCents: null, roiBps: null },
          valuation: { fresh: 0, stale: 1, unavailable: 0, pendingSettlement: 0, asOf: null },
          entryCohorts: [],
        },
      } });
      if (url.includes('/positions')) return response({ success: true, positions: [] });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    expect(await screen.findByText(/1 stale executable quote/)).toBeTruthy();
    expect(screen.getByText('Executable value').parentElement?.textContent).toBe('Executable valueUnavailable');
    expect(screen.getByText('Unrealized').parentElement?.textContent).toBe('UnrealizedUnavailable');
    expect(screen.getByText('No verified BotTrader executions in this range.')).toBeTruthy();
  });

  it('renders terminal value from the identity-validated resolution payout', async () => {
    const terminal = {
      ...positions[0],
      status: 'closed',
      totalCostCents: 97,
      currentValueCents: 88,
      realizedPnlCents: 3,
      resolutionPayoutCents: 100,
      resolutionValidationStatus: 'verified',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [terminal] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    await screen.findByText('Trump 2026');
    const row = screen.getByText('Trump 2026').closest('tr');
    expect(row?.textContent).toContain('$1.00+$0.03+3.1%');
    expect(row?.textContent).not.toContain('$0.88');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Trump 2026' }));
    expect(screen.getByText('Liquidation breakdown: Not applicable after resolution')).toBeTruthy();
    expect(screen.queryByTestId('combined-net-proceeds')).toBeNull();
  });

  it('derives settled ROI from realized P&L and total cost', () => {
    expect(positionRoiBps({ status: 'settled', totalCostCents: 200, realizedPnlCents: 25, unrealizedRoiBps: 9999 })).toBe(1250);
    expect(positionRoiBps({ status: 'open', totalCostCents: 200, realizedPnlCents: null, unrealizedRoiBps: 515 })).toBe(515);
  });

  it('renders status, analytics cents, and live positions from the bot APIs', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    stubInitialFetch();
    render(<BotTraderPanel />);

    await waitFor(() => expect(screen.getByText('Trump 2026')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Open Trump 2026 market' }).getAttribute('href')).toBe('/?view=scan&id=market-1');
    expect(screen.getByRole('link', { name: 'Open exact Kalshi YES market for Trump 2026' }).getAttribute('href')).toBe('https://kalshi.com/markets/kxtrump-26');
    expect(screen.getByRole('link', { name: 'Open exact Polymarket NO market for Trump 2026' }).getAttribute('href')).toBe('https://polymarket.com/event/trump-2026');
    expect(screen.getByText('Verified trades').parentElement?.textContent).toBe('Verified trades50');
    expect(screen.getByText('Open positions').parentElement?.textContent).toBe('Open positions12');
    expect(screen.getByText('Win rate').parentElement?.textContent).toBe('Win rate68.4%');
    expect(screen.getAllByText('+$0.05')).toHaveLength(3);
    expect(screen.getByText(/BotTrader: OFF/)).toBeTruthy();
    expect(screen.getByText('BotTrader Analytics')).toBeTruthy();
    const activeRange = screen.getByRole('button', { name: '30 Days' }) as HTMLButtonElement;
    expect(activeRange.disabled).toBe(true);
    expect(screen.getByText(/\$10\.50 staked/)).toBeTruthy();
  });

  it('maps buy cost, executable current value, P&L, and percentage ROI into their labelled columns', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    stubInitialFetch();
    render(<BotTraderPanel />);

    const marketLink = await screen.findByRole('link', { name: 'Open Trump 2026 market' });
    const row = marketLink.closest('tr');
    expect(row).toBeTruthy();
    const cells = Array.from(row!.querySelectorAll('td')).map((cell) => cell.textContent?.trim());
    expect(cells).toHaveLength(10);
    expect(cells[4]).toBe('$0.97');
    expect(cells[5]).toBe('$1.02');
    expect(cells[6]).toBe('+$0.05');
    expect(cells[7]).toBe('+5.2%');
  });

  it('shows stale open marks explicitly and does not invent zero P&L or ROI', async () => {
    vi.setSystemTime(new Date('2026-08-11T14:00:01.000Z'));
    stubInitialFetch();
    render(<BotTraderPanel />);

    const marketLink = await screen.findByRole('link', { name: 'Open Trump 2026 market' });
    const cells = Array.from(marketLink.closest('tr')!.querySelectorAll('td')).map((cell) => cell.textContent?.trim());
    expect(cells[4]).toBe('$0.97');
    expect(cells[5]).toBe('Stale');
    expect(cells[6]).toBe('Stale');
    expect(cells[7]).toBe('Stale');
  });

  it('shows unavailable open marks and safely suppresses ROI when buy cost is zero', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    const unavailablePosition = { ...positions[0], totalCostCents: 0, currentValueCents: null, unrealizedPnlCents: null, unrealizedRoiBps: null, lastValuationAt: null };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [unavailablePosition] } });
      if (url.includes('/positions')) return response({
        success: true,
        positions: [unavailablePosition],
      });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    const marketLink = await screen.findByRole('link', { name: 'Open Trump 2026 market' });
    const cells = Array.from(marketLink.closest('tr')!.querySelectorAll('td')).map((cell) => cell.textContent?.trim());
    expect(cells[4]).toBe('$0.00');
    expect(cells[5]).toBe('Unavailable');
    expect(cells[6]).toBe('Unavailable');
    expect(cells[7]).toBe('Unavailable');
  });

  it('expands position details from a keyboard-reachable row control', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);

    const expand = await screen.findByRole('button', { name: 'Expand Trump 2026' });
    fireEvent.click(expand);

    expect(screen.getByText('KXTRUMP-26')).toBeTruthy();
    expect(screen.getByText('0xabc')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse Trump 2026' })).toBeTruthy();
    expect(screen.getByTestId('kalshi-entry-cost').textContent).toContain('1 unit');
    expect(screen.getByTestId('kalshi-entry-cost').textContent).toContain('45.000¢ exact fill');
    expect(screen.getByTestId('combined-entry-cost').textContent).toBe('Reconciled Buy Cost$0.970000');
  });

  it('shows a specific unavailable Buy Cost reason for legacy paper positions and never displays zero', async () => {
    const legacy = { ...positions[0], entryCostStatus: 'unavailable', entryCostFailureReason: 'Legacy paper position lacks authoritative entry fill and fee data' };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: {
        ...analytics,
        positions: [legacy],
        performance: { ...analytics.performance, positionIds: [1], capital: { ...analytics.performance.capital, deployedCents: null }, entryCost: { available: 0, unavailable: 1 } },
      } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);
    const row = (await screen.findByText('Trump 2026')).closest('tr')!;
    expect(Array.from(row.querySelectorAll('td'))[4].textContent).toBe('Unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Trump 2026' }));
    expect(screen.getByText('Buy Cost unavailable: Legacy paper position lacks authoritative entry fill and fee data')).toBeTruthy();
    expect(screen.getByText('Deployed').parentElement?.textContent).toBe('DeployedUnavailable');
  });

  it('keeps summary cards, chart, and rows on the exact same execution mode population', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    const mixedPositions = [
      { ...positions[0], id: 1, marketTitle: 'Paper open profit' },
      { ...positions[0], id: 2, marketTitle: 'Prod open loss', dryRun: false, totalCostCents: 100, currentValueCents: 80 },
    ];
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) {
        const production = url.includes('mode=production');
        return response({ success: true, analytics: production ? {
          ...analytics,
          positions: mixedPositions.filter((position) => !position.dryRun),
          totalBotTrades: { paper: 0, production: 1, total: 1 },
          openPositions: { count: 1 },
          settledPositions: { count: 0, winRateBps: 0 },
          performance: {
            positionIds: [2],
            capital: { deployedCents: 100, currentCents: 80, heldToResolutionCents: 100 },
            pnl: { realizedCents: 0, unrealizedCents: -20, totalCents: -20, roiBps: -2000 },
            valuation: { fresh: 1, stale: 0, unavailable: 0, pendingSettlement: 0, asOf: positions[0].lastValuationAt },
            entryCohorts: [{ date: '2026-08-08', deployedCents: 100, currentCents: 80, heldToResolutionCents: 100, realizedCents: 0, unrealizedCents: -20, trades: 1 }],
          },
        } : { ...analytics, positions: mixedPositions.filter((position) => position.dryRun) } });
      }
      if (url.includes('/positions')) return response({ success: true, positions: mixedPositions });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);
    await screen.findByText('Paper open profit');

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter position mode' }), { target: { value: 'production' } });
    await screen.findByText('Prod open loss');
    expect(screen.queryByText('Paper open profit')).toBeNull();
    expect(screen.getByText('Verified trades').parentElement?.textContent).toBe('Verified trades1');
    expect(screen.getByText('Deployed').parentElement?.textContent).toBe('Deployed$1.00');
    expect(screen.getByText('Executable value').parentElement?.textContent).toBe('Executable value$0.80');
    expect(screen.getByText('Unrealized').parentElement?.textContent).toBe('Unrealized-$0.20');
    expect(screen.getByText('Realized').parentElement?.textContent).toBe('Realized$0.00');
    expect(screen.getByText('Total P&L').parentElement?.textContent).toBe('Total P&L-$0.20');
    expect(screen.getByRole('img', { name: 'BotTrader current performance by entry date chart' })).toBeTruthy();
  });

  it('expands authoritative per-leg gross, fee, and net proceeds that sum to Current Value', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    const feePosition = {
      ...positions[0],
      sharesKalshi: 10,
      sharesPm: 10,
      totalCostCents: 978,
      currentPriceKalshiCents: 46,
      currentPricePmCents: 55,
      kalshiGrossProceedsMicrocents: 455_000_000,
      pmGrossProceedsMicrocents: 550_000_000,
      kalshiNetProceedsCents: 437,
      pmNetProceedsCents: 540,
      kalshiExitFeeCents: 18,
      pmExitFeeCents: 10,
      currentValueCents: 977,
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [feePosition] } });
      if (url.includes('/positions')) return response({ success: true, positions: [feePosition] });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Trump 2026' }));
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('10 held');
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('45.500¢ VWAP');
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('$4.55 gross');
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('$0.18 fee');
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('$4.37 net');
    expect(screen.getByTestId('polymarket-liquidation').textContent).toContain('4.00%');
    expect(screen.getByTestId('polymarket-liquidation').textContent).toContain('$5.40 net');
    expect(screen.getByTestId('combined-net-proceeds').textContent).toBe('Combined net proceeds$9.77');
    expect(screen.getByTestId('combined-net-proceeds').textContent).toContain('$9.77');
  });

  it('renders rows from the same filtered analytics snapshot as cards and chart', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);
    await screen.findByText('Trump 2026');

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter position mode' }), { target: { value: 'production' } });
    expect(await screen.findByText('No verified BotTrader positions for these filters.')).toBeTruthy();
    expect(screen.queryByText('Trump 2026')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/positions'))).toHaveLength(0);
  });

  it('requires exact production confirmation and forwards it to the gated settings API', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Production' }));

    const confirmation = screen.getByRole('textbox', { name: 'Production confirmation' });
    const submit = screen.getByRole('button', { name: 'Confirm production' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(confirmation, { target: { value: 'PRODUCTION' } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      const settingsCall = vi.mocked(fetch).mock.calls.find((call: [unknown, RequestInit?]) => String(call[0]) === '/api/settings');
      expect(settingsCall).toBeTruthy();
      expect(JSON.parse(String(settingsCall?.[1]?.body))).toEqual({
        values: { 'bot.mode': 'production' },
        confirmation: 'PRODUCTION',
      });
    });
  });
});
