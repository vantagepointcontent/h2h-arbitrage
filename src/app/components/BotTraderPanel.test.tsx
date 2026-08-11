// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BotTraderPanel, { positionRoiBps } from './BotTraderPanel';

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
  vi.useRealTimers();
});

describe('BotTraderPanel', () => {
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
    expect(screen.getByText('Paper Trades').parentElement?.textContent).toBe('Paper Trades1');
    expect(screen.getByText('Prod Trades').parentElement?.textContent).toBe('Prod Trades0');
    expect(screen.getByText('Open Positions').parentElement?.textContent).toBe('Open Positions1');
    expect(screen.getByText('Win Rate').parentElement?.textContent).toBe('Win Rate0.0%');
    expect(screen.getAllByText('+$0.05')).toHaveLength(3);
    expect(screen.getByText(/BotTrader: OFF/)).toBeTruthy();
    expect(screen.getByText(/2 trades today/)).toBeTruthy();
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
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics });
      if (url.includes('/positions')) return response({
        success: true,
        positions: [{ ...positions[0], totalCostCents: 0, currentValueCents: null, unrealizedPnlCents: null, unrealizedRoiBps: null, lastValuationAt: null }],
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
  });

  it('filters the complete position population locally by status and paper/production mode', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);
    await screen.findByText('Trump 2026');

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter position mode' }), { target: { value: 'production' } });
    expect(screen.queryByText('Trump 2026')).toBeNull();
    expect(screen.getByText('No BotTrader positions.')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/positions'))).toHaveLength(1);
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
