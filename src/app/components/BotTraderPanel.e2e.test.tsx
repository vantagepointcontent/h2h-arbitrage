// @vitest-environment jsdom
import { createClient } from '@libsql/client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotPositionStore, type BotPosition } from '@/lib/bot-positions';
import BotTraderPanel from './BotTraderPanel';

const dirs: string[] = [];
const analytics = {
  totalBotTrades: { paper: 2, production: 0, total: 2 },
  openPositions: { count: 2, unrealizedPnlCents: 0 },
  settledPositions: { count: 0, realizedPnlCents: 0, winRateBps: 0 },
  averageRoi: { atTradeBps: 0, currentBps: 0 },
  bestTrade: null,
  worstTrade: null,
  dailyPnl: [],
  dailyPnlByMethod: { roi: [], apy: [], hybrid: [] },
  filter: { method: 'all', mode: 'all' },
  perMethod: {},
  timeStats: { tradesPerDayBps: 0, averageHoldSeconds: 0 },
};

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, json: async () => data });
}

function position(executionId: number, overrides: Partial<BotPosition> = {}) {
  return {
    executionId,
    marketId: 'pair-repeat',
    marketTitle: 'Repeated market fixture',
    kalshiTicker: 'KXREPEAT',
    pmConditionId: '0xrepeat',
    strategy: 'Buy YES Kalshi + NO PM',
    kalshiSide: 'yes',
    pmSide: 'no',
    buyPriceKalshiCents: 45,
    buyPricePmCents: 50,
    sharesKalshi: 10,
    sharesPm: 10,
    totalCostCents: 957,
    expectedPayoutCents: 1000,
    expectedProfitCents: 43,
    feesCents: 7,
    category: 'Politics',
    pmTheta: 0.04,
    kalshiEntryFeeCents: 4,
    pmEntryFeeCents: 3,
    openedAt: '2026-08-01T00:00:00.000Z',
    expiryDate: '2026-08-10T00:00:00.000Z',
    selectionMethod: 'hybrid',
    ...overrides,
  };
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('BotTrader repeated-execution persistence to analytics UI', () => {
  it('keeps immutable rows and reconciled live stake after reductions and a reload', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-ui-e2e-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'positions.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute('CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)');
    await client.execute('INSERT INTO executions (id, dry_run) VALUES (701, 1), (702, 1)');
    client.close();

    let store = new BotPositionStore(dbUrl);
    const first = await store.create(position(701, {
      expectedRoiBps: 449,
      expectedApyBps: 18_210,
      unitId: 'execution:701',
    }) as never);
    const second = await store.create(position(702, {
      buyPriceKalshiCents: 40,
      buyPricePmCents: 50,
      totalCostCents: 905,
      expectedProfitCents: 95,
      expectedRoiBps: 1_050,
      expectedApyBps: 42_583,
      unitId: 'execution:702',
      feesCents: 5,
      kalshiEntryFeeCents: 3,
      pmEntryFeeCents: 2,
      openedAt: '2026-08-01T01:00:00.000Z',
    }) as never);

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return jsonResponse({ success: true, analytics });
      if (url.includes('/positions')) {
        const page = await store.listMarkets({ status: 'all', limit: 100 });
        return jsonResponse({ success: true, ...page });
      }
      if (url.includes('/status')) return jsonResponse({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 18.62 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<BotTraderPanel />);

    const parent = await screen.findByTestId('market-market:pair-repeat');
    expect(within(parent).getByLabelText('Repeated market fixture live stake').textContent).toBe('$18.62');
    const firstRow = screen.getByTestId('execution-701');
    const secondRow = screen.getByTestId('execution-702');
    expect(firstRow.className).toContain('bg-[#071a33]');
    expect(secondRow.className).toContain('bg-[#071a33]');
    expect(within(firstRow).getByLabelText('Execution 701 Buy Cost').textContent).toBe('$9.57');
    expect(within(secondRow).getByLabelText('Execution 702 Buy Cost').textContent).toBe('$9.05');
    expect(within(firstRow).getByText('execution:701')).toBeTruthy();
    expect(within(secondRow).getByText('execution:702')).toBeTruthy();
    expect(within(firstRow).getByText('+4.5%')).toBeTruthy();
    expect(within(secondRow).getByText('+10.5%')).toBeTruthy();
    expect(within(firstRow).getByText('182.1%')).toBeTruthy();
    expect(within(secondRow).getByText('425.8%')).toBeTruthy();
    expect(firstRow.querySelector('[title="2026-08-01T00:00:00.000Z"]')).toBeTruthy();
    expect(secondRow.querySelector('[title="2026-08-01T01:00:00.000Z"]')).toBeTruthy();
    expect(within(firstRow).getByText(/45¢ × 10/)).toBeTruthy();
    expect(within(firstRow).getByText(/50¢ × 10/)).toBeTruthy();
    expect(within(secondRow).getByText(/40¢ × 10/)).toBeTruthy();

    await store.reduceExposure(first.id, {
      expectedRemainingSharesKalshi: 10,
      expectedRemainingSharesPm: 10,
      expectedLastValuationAt: '2026-08-01T00:00:00.000Z',
      remainingSharesKalshi: 5,
      remainingSharesPm: 5,
      realizedPnlCents: 11,
      observedAt: '2026-08-02T00:00:00.000Z',
    });
    await store.reduceExposure(second.id, {
      expectedRemainingSharesKalshi: 10,
      expectedRemainingSharesPm: 10,
      expectedLastValuationAt: '2026-08-01T01:00:00.000Z',
      remainingSharesKalshi: 0,
      remainingSharesPm: 0,
      realizedPnlCents: -5,
      observedAt: '2026-08-03T00:00:00.000Z',
    });
    store.close();
    store = new BotPositionStore(dbUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh BotTrader analytics' }));

    await waitFor(() => expect(within(screen.getByTestId('market-market:pair-repeat')).getByLabelText('Repeated market fixture live stake').textContent).toBe('$4.79'));
    const reloadedFirst = screen.getByTestId('execution-701');
    const reloadedSecond = screen.getByTestId('execution-702');
    expect(within(reloadedFirst).getByLabelText('Execution 701 Buy Cost').textContent).toBe('$9.57');
    expect(within(reloadedSecond).getByLabelText('Execution 702 Buy Cost').textContent).toBe('$9.05');
    expect(within(reloadedFirst).getByText('execution:701')).toBeTruthy();
    expect(within(reloadedSecond).getByText('execution:702')).toBeTruthy();
    expect(within(reloadedFirst).getByText('+4.5%')).toBeTruthy();
    expect(within(reloadedSecond).getByText('+10.5%')).toBeTruthy();
    expect(within(reloadedFirst).getByText('182.1%')).toBeTruthy();
    expect(within(reloadedSecond).getByText('425.8%')).toBeTruthy();
    expect(within(reloadedFirst).getByLabelText('Execution 701 remaining exposure').textContent).toBe('$4.79');
    expect(within(reloadedSecond).getByLabelText('Execution 702 remaining exposure').textContent).toBe('$0.00');
    expect(within(reloadedFirst).getByText('partially_closed')).toBeTruthy();
    expect(within(reloadedSecond).getByText('closed')).toBeTruthy();
    expect(reloadedFirst.querySelector('[title="2026-08-01T00:00:00.000Z"]')).toBeTruthy();
    expect(reloadedSecond.querySelector('[title="2026-08-01T01:00:00.000Z"]')).toBeTruthy();
    expect(within(reloadedFirst).getByText(/45¢ × 10/)).toBeTruthy();
    expect(within(reloadedSecond).getByText(/40¢ × 10/)).toBeTruthy();
    store.close();
  });
});
