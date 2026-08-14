// @vitest-environment jsdom
import { createClient } from '@libsql/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  performance: {
    positionIds: [1, 2],
    capital: { deployedCents: 1864, currentCents: 1864, heldToResolutionCents: 2000 },
    pnl: { realizedCents: 0, unrealizedCents: 0, totalCents: 0, roiBps: 0 },
    valuation: { fresh: 0, stale: 0, unavailable: 2, pendingSettlement: 0, asOf: null },
    entryCohorts: [],
  },
};

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, json: async () => data });
}

function position(executionId: number, overrides: Partial<BotPosition> = {}) {
  return {
    executionId,
    executionMode: 'paper' as const,
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
    kalshiEntryGrossMicrocents: 450_000_000,
    pmEntryGrossMicrocents: 500_000_000,
    entryCostRoundingDeltaMicrocents: 0,
    kalshiEntryFillCount: 1,
    pmEntryFillCount: 1,
    totalCostCents: 957,
    expectedPayoutCents: 1000,
    expectedProfitCents: 43,
    feesCents: 7,
    category: 'Politics',
    pmTheta: 0.012,
    kalshiEntryFeeType: 'quadratic',
    kalshiEntryFeeMultiplierPpm: 200_000,
    kalshiEntryFeeSource: 'kalshi-series:KXREPEAT',
    kalshiEntryFeeObservedAt: '2026-08-01T00:00:00.000Z',
    kalshiEntryFeeVersion: 'series-v1',
    pmEntryTokenId: 'pm-no-token',
    pmEntryFeeRateBps: 120,
    pmEntryFeeSource: 'polymarket-clob:/fee-rate',
    pmEntryFeeObservedAt: '2026-08-01T00:00:00.000Z',
    pmEntryFeeVersion: 'clob-v1',
    kalshiExitFeeType: 'quadratic',
    kalshiExitFeeMultiplierPpm: 200_000,
    kalshiExitFeeSource: 'kalshi-series:KXREPEAT',
    kalshiExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
    kalshiExitFeeVersion: 'series-v1',
    pmExitTokenId: 'pm-no-token',
    pmExitFeeRateBps: 120,
    pmExitFeeSource: 'polymarket-clob:/fee-rate',
    pmExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
    pmExitFeeVersion: 'clob-v1',
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
      pmConditionId: '0xrepeat-second-leg',
      buyPriceKalshiCents: 40,
      buyPricePmCents: 50,
      kalshiEntryGrossMicrocents: 400_000_000,
      pmEntryGrossMicrocents: 500_000_000,
      totalCostCents: 907,
      expectedProfitCents: 93,
      expectedRoiBps: 1_050,
      expectedApyBps: 42_583,
      unitId: 'execution:702',
      feesCents: 7,
      kalshiEntryFeeCents: 4,
      pmEntryFeeCents: 3,
      openedAt: '2026-08-01T01:00:00.000Z',
      kalshiEntryFeeObservedAt: '2026-08-01T01:00:00.000Z',
      pmEntryFeeObservedAt: '2026-08-01T01:00:00.000Z',
      kalshiExitFeeObservedAt: '2026-08-01T01:00:00.000Z',
      pmExitFeeObservedAt: '2026-08-01T01:00:00.000Z',
    }) as never);

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) {
        return jsonResponse({ success: true, analytics: { ...analytics, positions: await store.list({ status: 'all' }) } });
      }
      if (url.includes('/positions')) {
        const page = await store.listMarkets({ status: 'all', limit: 100 });
        return jsonResponse({ success: true, ...page });
      }
      if (url.includes('/status')) return jsonResponse({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 18.62 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<BotTraderPanel />);

    const marketLinks = await screen.findAllByRole('link', { name: 'Open Repeated market fixture market' });
    expect(marketLinks).toHaveLength(2);
    const firstRow = marketLinks.find((link) => link.closest('tr')?.textContent?.includes('#701'))!.closest('tr')!;
    const secondRow = marketLinks.find((link) => link.closest('tr')?.textContent?.includes('#702'))!.closest('tr')!;
    expect(firstRow.textContent).toContain('$9.57');
    expect(secondRow.textContent).toContain('$9.07');
    expect(firstRow.textContent).toContain('#701');
    expect(secondRow.textContent).toContain('#702');

    await store.reduceExposure(first.id, {
      expectedRemainingSharesKalshi: 10,
      expectedRemainingSharesPm: 10,
      expectedLastValuationAt: null,
      remainingSharesKalshi: 5,
      remainingSharesPm: 5,
      realizedPnlCents: 11,
      observedAt: '2026-08-02T00:00:00.000Z',
    });
    await store.reduceExposure(second.id, {
      expectedRemainingSharesKalshi: 10,
      expectedRemainingSharesPm: 10,
      expectedLastValuationAt: null,
      remainingSharesKalshi: 0,
      remainingSharesPm: 0,
      realizedPnlCents: -5,
      observedAt: '2026-08-03T00:00:00.000Z',
    });
    store.close();
    store = new BotPositionStore(dbUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh BotTrader analytics' }));

    await waitFor(async () => {
      expect((await store.getById(first.id))?.status).toBe('open');
      expect((await store.getById(second.id))?.status).toBe('closed');
    });
    const reloadedLinks = screen.getAllByRole('link', { name: 'Open Repeated market fixture market' });
    expect(reloadedLinks.find((link) => link.closest('tr')?.textContent?.includes('#701'))!.closest('tr')!.textContent).toContain('$9.57');
    expect(reloadedLinks.find((link) => link.closest('tr')?.textContent?.includes('#702'))!.closest('tr')!.textContent).toContain('$9.07');
    store.close();
  });
});
