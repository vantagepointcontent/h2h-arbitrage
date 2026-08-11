// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BotTraderPanel, { positionRoiBps } from './BotTraderPanel';

const EMPTY_ANALYTICS_FOR_TEST = {
  totalBotTrades: { paper: 0, production: 0, total: 0 },
  openPositions: { count: 0, unrealizedPnlCents: 0 },
  settledPositions: { count: 0, realizedPnlCents: 0, winRateBps: 0 },
  dailyPnl: [],
};

const analytics = {
  totalBotTrades: { paper: 47, production: 3, total: 50 },
  openPositions: { count: 12, unrealizedPnlCents: 1234 },
  settledPositions: { count: 19, realizedPnlCents: 567, winRateBps: 6842 },
  averageRoi: { atTradeBps: 240, currentBps: 190 },
  bestTrade: null,
  worstTrade: null,
  dailyPnl: [],
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
  lastValuationAt: new Date().toISOString(),
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
    expect(screen.getByText('Configured opportunities')).toBeTruthy();
    expect(screen.getByText(/Selection rules only; not placement attempts or positions/)).toBeTruthy();
    expect(screen.getByText('Open positions')).toBeTruthy();
    expect(screen.getAllByText('Current executable value').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('+5.2% of allocated capital')).toBeTruthy();
    expect(screen.getByText('Paper')).toBeTruthy();
    expect(screen.getByText('Placed · Open')).toBeTruthy();
  });

  it('expands position details from a keyboard-reachable row control', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);

    const expand = await screen.findByRole('button', { name: 'Expand Trump 2026' });
    fireEvent.click(expand);

    expect(screen.getByText('KXTRUMP-26')).toBeTruthy();
    expect(screen.getByText('0xabc')).toBeTruthy();
    expect(screen.getByText('Kalshi leg')).toBeTruthy();
    expect(screen.getByText('Polymarket leg')).toBeTruthy();
    expect(screen.getByText(/Current executable value = Kalshi bid/)).toBeTruthy();
    expect(screen.getByText(/P\/L % denominator: allocated capital/)).toBeTruthy();
    expect(screen.getByText(/Balanced: 1 contract on each leg/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse Trump 2026' })).toBeTruthy();
  });

  it('labels stale or unavailable open valuations instead of presenting them as current', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics });
      if (url.includes('/positions')) return response({ success: true, positions: [
        { ...positions[0], id: 2, marketTitle: 'Old valuation market', lastValuationAt: '2020-01-01T00:00:00.000Z' },
        { ...positions[0], id: 3, marketTitle: 'Missing quote', currentPricePmCents: null, currentValueCents: null, unrealizedPnlCents: null, unrealizedRoiBps: null, lastValuationAt: null },
      ] });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<BotTraderPanel />);
    await screen.findByText('Old valuation market');
    expect(screen.getByText('Stale valuation')).toBeTruthy();
    expect(screen.getByText('Last executable quote (stale)')).toBeTruthy();
    expect(screen.getByText('Valuation unavailable')).toBeTruthy();
    expect(screen.getByText('Missing Polymarket executable bid')).toBeTruthy();
    expect(screen.getAllByText('Stale quote')).toHaveLength(2);
  });

  it('separates completed trades and labels settlement value and realized return', async () => {
    const settled = {
      ...positions[0], id: 4, marketTitle: 'Settled market', status: 'settled',
      currentValueCents: 100, realizedPnlCents: 3, settledAt: '2026-08-09T12:00:00.000Z', settlementSide: 'kalshi',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics });
      if (url.includes('/positions')) return response({ success: true, positions: [settled] });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<BotTraderPanel />);
    await screen.findByText('Settled market');
    expect(screen.getByText('Completed / settled trades')).toBeTruthy();
    expect(screen.getAllByText('Settlement value').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('+3.1% of allocated capital')).toBeTruthy();
    expect(screen.getByText('Placed · Settled')).toBeTruthy();
  });

  it('shows explicit empty states for open and completed positions', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: EMPTY_ANALYTICS_FOR_TEST });
      if (url.includes('/positions')) return response({ success: true, positions: [] });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);
    expect(await screen.findByText('No open BotTrader positions.')).toBeTruthy();
    expect(screen.getByText('No completed BotTrader trades.')).toBeTruthy();
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
