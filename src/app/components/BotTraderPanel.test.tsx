// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BotTraderPanel, { positionRoiBps } from './BotTraderPanel';

const analytics = {
  totalBotTrades: { paper: 47, production: 3, total: 50 },
  openPositions: { count: 12, unrealizedPnlCents: 1234 },
  settledPositions: { count: 19, realizedPnlCents: 567, winRateBps: 6842 },
  averageRoi: { atTradeBps: 240, currentBps: 190 },
  bestTrade: null,
  worstTrade: null,
  dailyPnl: [],
  dailyPnlByMethod: {
    roi: [{ date: '2026-08-01', realizedPnlCents: 500, unrealizedPnlCents: 100, trades: 4 }],
    apy: [],
    hybrid: [{ date: '2026-08-01', realizedPnlCents: -100, unrealizedPnlCents: 0, trades: 1 }],
  },
  filter: { method: 'all', mode: 'all' },
  perMethod: {
    roi: { tradeCount: 4, deployedCapitalCents: 10000, realizedPnlCents: 500, unrealizedPnlCents: 100, winRateBps: 7500, averageEntryRoiBps: 800, currentRoiBps: 600, averageApyPct: 42.5 },
    apy: { tradeCount: 0, deployedCapitalCents: 0, realizedPnlCents: 0, unrealizedPnlCents: 0, winRateBps: 0, averageEntryRoiBps: 0, currentRoiBps: 0, averageApyPct: null },
    hybrid: { tradeCount: 1, deployedCapitalCents: 5000, realizedPnlCents: -100, unrealizedPnlCents: 0, winRateBps: 0, averageEntryRoiBps: 200, currentRoiBps: -200, averageApyPct: 10 },
    legacy: { tradeCount: 2, deployedCapitalCents: 2000, realizedPnlCents: 0, unrealizedPnlCents: 0, winRateBps: 0, averageEntryRoiBps: 0, currentRoiBps: 0, averageApyPct: null },
  },
  timeStats: { tradesPerDayBps: 10000, averageHoldSeconds: 0 },
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
  unrealizedPnlCents: 5,
  unrealizedRoiBps: 515,
  lastValuationAt: '2026-08-08T18:00:00.000Z',
  realizedPnlCents: null,
  settlementSide: null,
  dryRun: true,
}];

const repeatedMarket = {
  marketKey: 'market:market-1',
  marketId: 'market-1',
  marketTitle: 'Trump 2026',
  kalshiTicker: 'KXTRUMP-26',
  pmConditionId: '0xabc',
  currentLiveStakeCents: 9640,
  currentValueCents: 9900,
  unrealizedPnlCents: 260,
  realizedPnlCents: -120,
  status: 'open',
  latestExecutionAt: '2026-08-08T17:00:00.000Z',
  executions: [
    {
      entryId: 102,
      executionId: 502,
      tradeId: 'trade-second',
      executedAt: '2026-08-08T17:00:00.000Z',
      mode: 'paper',
      strategy: 'Buy YES K + NO PM',
      status: 'closed',
      legs: [
        { venue: 'kalshi', marketRef: 'KXTRUMP-26', side: 'yes', executionPriceCents: 43, originalQuantity: 100, originalPrincipalCents: 4300, entryFeeCents: 30, remainingOpenQuantity: 0, remainingOpenPrincipalCents: 0, remainingOpenFeeCents: 0, currentExecutablePriceCents: null, currentLiquidationValueCents: null },
        { venue: 'polymarket', marketRef: '0xabc', side: 'no', executionPriceCents: 51, originalQuantity: 100, originalPrincipalCents: 5100, entryFeeCents: 40, remainingOpenQuantity: 0, remainingOpenPrincipalCents: 0, remainingOpenFeeCents: 0, currentExecutablePriceCents: null, currentLiquidationValueCents: null },
      ],
      executionPrincipalCents: 9400,
      executionFeesCents: 70,
      executionBuyCostCents: 9470,
      remainingOpenPrincipalCents: 0,
      remainingOpenFeesCents: 0,
      remainingOpenCostCents: 0,
      currentValueCents: 0,
      unrealizedPnlCents: 0,
      realizedPnlCents: -120,
      openedAt: '2026-08-08T17:00:00.000Z',
      closedAt: '2026-08-09T17:00:00.000Z',
      settledAt: null,
      lastValuationAt: '2026-08-09T17:00:00.000Z',
    },
    {
      entryId: 101,
      executionId: 501,
      tradeId: 'trade-first',
      executedAt: '2026-08-08T16:00:00.000Z',
      mode: 'production',
      strategy: 'Buy YES K + NO PM',
      status: 'open',
      legs: [
        { venue: 'kalshi', marketRef: 'KXTRUMP-26', side: 'yes', executionPriceCents: 45, originalQuantity: 100, originalPrincipalCents: 4500, entryFeeCents: 20, remainingOpenQuantity: 100, remainingOpenPrincipalCents: 4500, remainingOpenFeeCents: 20, currentExecutablePriceCents: 46, currentLiquidationValueCents: 4580 },
        { venue: 'polymarket', marketRef: '0xabc', side: 'no', executionPriceCents: 51, originalQuantity: 100, originalPrincipalCents: 5100, entryFeeCents: 20, remainingOpenQuantity: 100, remainingOpenPrincipalCents: 5100, remainingOpenFeeCents: 20, currentExecutablePriceCents: 54, currentLiquidationValueCents: 5320 },
      ],
      executionPrincipalCents: 9600,
      executionFeesCents: 40,
      executionBuyCostCents: 9640,
      remainingOpenPrincipalCents: 9600,
      remainingOpenFeesCents: 40,
      remainingOpenCostCents: 9640,
      currentValueCents: 9900,
      unrealizedPnlCents: 260,
      realizedPnlCents: 0,
      openedAt: '2026-08-08T16:00:00.000Z',
      closedAt: null,
      settledAt: null,
      lastValuationAt: '2026-08-08T18:00:00.000Z',
    },
  ],
};

function response(data: unknown, ok = true) {
  return Promise.resolve({ ok, json: async () => data });
}

function stubInitialFetch() {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/analytics')) return response({ success: true, analytics });
    if (url.includes('/positions')) return response({ success: true, positions });
    if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
    throw new Error(`Unexpected fetch: ${url}`);
  }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BotTraderPanel', () => {
  it('derives settled ROI from realized P&L and total cost', () => {
    expect(positionRoiBps({ status: 'settled', totalCostCents: 200, realizedPnlCents: 25, unrealizedRoiBps: 9999 })).toBe(1250);
    expect(positionRoiBps({ status: 'open', totalCostCents: 200, realizedPnlCents: null, unrealizedRoiBps: 515 })).toBe(515);
  });

  it('renders status, analytics cents, and live positions from the bot APIs', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);

    await waitFor(() => expect(screen.getByText('Trump 2026')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Open Trump 2026 market' }).getAttribute('href')).toBe('/?view=scan&id=market-1');
    expect(screen.getByRole('link', { name: 'Open exact Kalshi YES market for Trump 2026' }).getAttribute('href')).toBe('https://kalshi.com/markets/kxtrump-26');
    expect(screen.getByRole('link', { name: 'Open exact Polymarket NO market for Trump 2026' }).getAttribute('href')).toBe('https://polymarket.com/event/trump-2026');
    expect(screen.getByText('47')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('68.4%')).toBeTruthy();
    expect(screen.getByText('+$12.34')).toBeTruthy();
    expect(screen.getByText('+$5.67')).toBeTruthy();
    expect(screen.getByText('+$18.01')).toBeTruthy();
    expect(screen.getByText(/BotTrader: OFF/)).toBeTruthy();
    expect(screen.getByText(/2 trades today/)).toBeTruthy();
    expect(screen.getByText(/\$10\.50 staked/)).toBeTruthy();
  });

  it('renders repeated executions as stable rows with immutable distinct buy costs and closed history', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics });
      if (url.includes('/positions')) return response({ success: true, markets: [repeatedMarket] });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<BotTraderPanel />);

    const parent = await screen.findByTestId('market-market:market-1');
    expect(within(parent).getByText('$96.40')).toBeTruthy();
    const first = screen.getByTestId('execution-501');
    const second = screen.getByTestId('execution-502');
    expect(within(first).getByLabelText('Execution 501 Buy Cost').textContent).toBe('$96.40');
    expect(within(second).getByLabelText('Execution 502 Buy Cost').textContent).toBe('$94.70');
    expect(within(first).getByText(/trade-first/)).toBeTruthy();
    expect(within(second).getByText(/trade-second/)).toBeTruthy();
    expect(within(second).getByText('closed')).toBeTruthy();
    expect(within(second).getByText(/43¢ × 100/)).toBeTruthy();
    expect(within(second).getByText(/51¢ × 100/)).toBeTruthy();
    expect(within(second).getByLabelText('Execution 502 remaining exposure').textContent).toBe('$0.00');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Trump 2026' }));
    expect(screen.queryByTestId('execution-501')).toBeNull();
  });

  it('updates only the parent live total on refetch while preserving execution identities and buy costs', async () => {
    let closed = false;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics });
      if (url.includes('/positions')) {
        const market = closed
          ? { ...repeatedMarket, currentLiveStakeCents: 0, currentValueCents: 0, unrealizedPnlCents: 0, status: 'closed' }
          : repeatedMarket;
        return response({ success: true, markets: [market] });
      }
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<BotTraderPanel />);
    await screen.findByTestId('execution-501');
    closed = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh BotTrader analytics' }));

    await waitFor(() => expect(within(screen.getByTestId('market-market:market-1')).getByLabelText('Trump 2026 live stake').textContent).toBe('$0.00'));
    expect(within(screen.getByTestId('execution-501')).getByLabelText('Execution 501 Buy Cost').textContent).toBe('$96.40');
    expect(within(screen.getByTestId('execution-502')).getByLabelText('Execution 502 Buy Cost').textContent).toBe('$94.70');
  });

  it('keeps the legacy single-entry response readable and makes Buy Cost fee-inclusive', async () => {
    const legacy = [{ ...positions[0], totalCostCents: 100, feesCents: 3 }];
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics });
      if (url.includes('/positions')) return response({ success: true, positions: legacy });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<BotTraderPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Trump 2026' }));
    const execution = screen.getByTestId('execution-9');
    expect(within(execution).getByLabelText('Execution 9 Buy Cost').textContent).toBe('$1.00');
    expect(screen.getAllByText('Trump 2026')).toHaveLength(1);
  });

  it('expands position details from a keyboard-reachable row control', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);

    const expand = await screen.findByRole('button', { name: 'Expand Trump 2026' });
    fireEvent.click(expand);

    expect(screen.getByText('KXTRUMP-26')).toBeTruthy();
    expect(screen.getByText('0xabc')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse Trump 2026' })).toBeTruthy();
  });

  it('composes selection-method and paper/production analytics filters', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);
    await screen.findByText('Trump 2026');
    expect(screen.getByRole('listitem', { name: 'roi method performance' })).toBeTruthy();
    expect(screen.getAllByText('Legacy / Unknown').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'apy' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Analytics trading mode' }), { target: { value: 'production' } });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((call) => String(call[0]).includes('/api/bot-trader/analytics?method=apy&mode=production'))).toBe(true));
    expect(screen.getByText('No performance data for this filter.')).toBeTruthy();
  });

  it('ignores stale refresh responses after a newer filter request completes', async () => {
    let phase: 'initial' | 'stale' | 'fresh' = 'initial';
    const staleResolvers: Array<(value: { ok: boolean; json: () => Promise<unknown> }) => void> = [];
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (phase === 'stale') {
        return new Promise((resolve) => staleResolvers.push(resolve));
      }
      const visiblePositions = phase === 'fresh'
        ? [{ ...positions[0], id: 2, marketTitle: 'Fresh open position' }]
        : positions;
      if (url.includes('/analytics')) return response({ success: true, analytics });
      if (url.includes('/positions')) return response({ success: true, positions: visiblePositions });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<BotTraderPanel />);
    await screen.findByText('Trump 2026');

    phase = 'stale';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh BotTrader analytics' }));
    await waitFor(() => expect(staleResolvers).toHaveLength(3));

    phase = 'fresh';
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await screen.findByText('Fresh open position');

    staleResolvers[0]({ ok: true, json: async () => ({ success: true, analytics }) });
    staleResolvers[1]({ ok: true, json: async () => ({ success: true, positions }) });
    staleResolvers[2]({ ok: true, json: async () => ({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 }) });

    await waitFor(() => expect(screen.queryByText('Trump 2026')).toBeNull());
    expect(screen.getByText('Fresh open position')).toBeTruthy();
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
