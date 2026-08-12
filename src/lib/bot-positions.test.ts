import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BotPositionStore,
  calculatePositionValuation,
  fetchKalshiBidLevels,
  getKalshiResolvedPrices,
  pollOpenBotPositions,
  summarizeBotPositions,
  calculateAuthoritativeKalshiFeeCents,
  type BotPosition,
} from './bot-positions';

describe('calculateAuthoritativeKalshiFeeCents', () => {
  it('applies the authoritative multiplier before the venue cent ceiling', () => {
    expect(calculateAuthoritativeKalshiFeeCents(1, 0.14, 1_250_000)).toBe(2);
    expect(calculateAuthoritativeKalshiFeeCents(1, 0.14, 0)).toBe(0);
  });
});

function openPosition(overrides: Partial<BotPosition> = {}): BotPosition {
  return {
    id: 1,
    executionId: 7,
    marketId: 'pair-1',
    marketTitle: 'Test market',
    kalshiTicker: 'KXTEST',
    pmConditionId: '0xabc',
    strategy: 'Buy YES Kalshi + NO PM',
    kalshiSide: 'yes',
    pmSide: 'no',
    buyPriceKalshiCents: 45,
    buyPricePmCents: 50,
    sharesKalshi: 10,
    sharesPm: 10,
    remainingSharesKalshi: 10,
    remainingSharesPm: 10,
    remainingOpenPrincipalCents: 950,
    remainingOpenFeesCents: 0,
    remainingOpenCostCents: 950,
    totalCostCents: 950,
    expectedPayoutCents: 1000,
    expectedProfitCents: 50,
    expectedRoiBps: 526,
    expectedApyBps: null,
    unitId: 'execution:7',
    feesCents: 0,
    category: 'Politics',
    pmTheta: 0.04,
    kalshiEntryFeeCents: 0,
    pmEntryFeeCents: 0,
    status: 'open',
    openedAt: '2026-08-01T00:00:00.000Z',
    expiryDate: '2026-08-10T00:00:00.000Z',
    settledAt: null,
    closedAt: null,
    currentPriceKalshiCents: 45,
    currentPricePmCents: 55,
    currentValueCents: 1000,
    unrealizedPnlCents: 50,
    unrealizedRoiBps: 526,
    lastValuationAt: '2026-08-01T00:00:00.000Z',
    valuationStatus: 'current',
    valuationFailureReason: null,
    valuationFailureAt: null,
    kalshiValuationDepth: 10,
    pmValuationDepth: 10,
    kalshiExitFeeCents: 12,
    pmExitFeeCents: 6,
    kalshiLiquidationValueCents: 468,
    pmLiquidationValueCents: 554,
    kalshiQuoteTimestamp: '2026-08-01T00:00:00.000Z',
    pmQuoteTimestamp: '2026-08-01T00:00:00.000Z',
    kalshiQuoteSource: 'kalshi_orderbook',
    pmQuoteSource: 'polymarket_clob_book',
    realizedPnlCents: null,
    settlementSide: null,
    dryRun: true,
    ...overrides,
  };
}

describe('summarizeBotPositions', () => {
  it('reconciles fee-net capital, P&L, ROI, win rate, and entry APY for one method', () => {
    const rows = [
      openPosition({ id: 1, selectionMethod: 'roi', totalCostCents: 1000, expectedProfitCents: 100, unrealizedPnlCents: 50, openedAt: '2026-08-01T00:00:00.000Z', expiryDate: '2026-08-11T00:00:00.000Z' }),
      openPosition({ id: 2, selectionMethod: 'roi', status: 'settled', totalCostCents: 1000, expectedProfitCents: 100, unrealizedPnlCents: null, realizedPnlCents: 200, settledAt: '2026-08-05T00:00:00.000Z', openedAt: '2026-08-01T00:00:00.000Z', expiryDate: '2026-08-11T00:00:00.000Z' }),
    ];
    expect(summarizeBotPositions(rows)).toEqual({
      tradeCount: 2,
      deployedCapitalCents: 2000,
      realizedPnlCents: 200,
      unrealizedPnlCents: 50,
      winRateBps: 10_000,
      averageEntryRoiBps: 1000,
      currentRoiBps: 1250,
      averageApyPct: 365,
    });
  });

  it('returns honest zero and no-data values for an empty method', () => {
    expect(summarizeBotPositions([])).toEqual({ tradeCount: 0, deployedCapitalCents: 0, realizedPnlCents: 0, unrealizedPnlCents: 0, winRateBps: 0, averageEntryRoiBps: 0, currentRoiBps: 0, averageApyPct: null });
  });
});

describe('calculatePositionValuation', () => {
  it('applies the Kalshi fee ceiling once after walking multiple levels', () => {
    const result = calculatePositionValuation(openPosition({
      remainingSharesKalshi: 3,
      remainingSharesPm: 3,
      remainingOpenCostCents: 300,
    }), {
      kalshiYesBidCents: 10,
      kalshiNoBidCents: 90,
      pmYesBidCents: 10,
      pmNoBidCents: 90,
      kalshiHeldBidLevels: [
        { priceCents: 10, quantity: 1 },
        { priceCents: 10, quantity: 1 },
        { priceCents: 10, quantity: 1 },
      ],
      pmHeldBidLevels: [{ priceCents: 90, quantity: 3 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    });

    expect(result.legs.kalshi).toMatchObject({ grossProceedsCents: 30, exitFeeCents: 2, netProceedsCents: 28 });
  });

  it('values both held legs from executable depth and subtracts both exit fees', () => {
    const result = calculatePositionValuation(openPosition({ remainingSharesKalshi: 3, remainingSharesPm: 3, remainingOpenCostCents: 285 }), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiHeldBidLevels: [{ priceCents: 48, quantity: 2 }, { priceCents: 47, quantity: 4 }],
      pmHeldBidLevels: [{ priceCents: 57, quantity: 3 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    });

    expect(result.currentValueCents).toBe(305);
    expect(result.legs.kalshi).toMatchObject({ executableDepthUsed: 3, grossProceedsCents: 143, exitFeeCents: 6, netProceedsCents: 137 });
    expect(result.legs.polymarket).toMatchObject({ executableDepthUsed: 3, grossProceedsCents: 171, exitFeeCents: 3, netProceedsCents: 168 });
  });

  it('fails closed when either held leg has insufficient executable depth', () => {
    expect(() => calculatePositionValuation(openPosition({ remainingSharesKalshi: 2 }), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiHeldBidLevels: [{ priceCents: 48, quantity: 1 }],
      pmHeldBidLevels: [{ priceCents: 57, quantity: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/insufficient Kalshi executable depth.*available 1, required 2, shortfall 1/i);
  });

  it('marks an open YES-Kalshi/NO-PM position to executable sell bids using integer cents', () => {
    const result = calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      status: 'open',
      currentPriceKalshiCents: 48,
      currentPricePmCents: 57,
      currentValueCents: 1022,
      unrealizedPnlCents: 72,
      unrealizedRoiBps: 758,
      lastValuationAt: '2026-08-08T12:00:00.000Z',
      settledAt: null,
      realizedPnlCents: null,
      settlementSide: null,
    });
  });

  it('fails closed when an executable bid is missing', () => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: null,
      kalshiNoBidCents: 100,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    })).toThrow(/missing executable/i);
  });

  it('fails closed instead of inventing a default fee theta for legacy positions', () => {
    expect(() => calculatePositionValuation(openPosition({ pmTheta: null }), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/missing authoritative Polymarket theta/i);
  });

  it('settles only after expiry when held-side prices are exactly 100 and 0 cents without double-counting persisted entry fees', () => {
    const result = calculatePositionValuation(openPosition({ feesCents: 7, totalCostCents: 957, remainingOpenFeesCents: 7, remainingOpenCostCents: 957 }), {
      kalshiYesBidCents: 100,
      kalshiNoBidCents: 0,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-11T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: true,
      pmResolved: true,
    });

    expect(result.status).toBe('settled');
    expect(result.currentValueCents).toBe(1000);
    expect(result.realizedPnlCents).toBe(43);
    expect(result.settlementSide).toBe('kalshi');
    expect(result.settledAt).toBe('2026-08-11T12:00:00.000Z');
  });

  it('does not settle contradictory resolution prices', () => {
    const result = calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 100,
      kalshiNoBidCents: 0,
      pmYesBidCents: 0,
      pmNoBidCents: 100,
      observedAt: '2026-08-11T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: true,
      pmResolved: true,
    });
    expect(result.status).toBe('open');
  });

  it('uses authoritative Kalshi settlement value when finalized books have no bids', () => {
    const kalshiResolution = getKalshiResolvedPrices({
      status: 'settled',
      settlement_value_dollars: '1.0000',
      yes_bid_dollars: undefined,
      no_bid_dollars: undefined,
    });
    expect(kalshiResolution).toEqual({ yesBidCents: 100, noBidCents: 0, resolved: true });

    const result = calculatePositionValuation(openPosition({ feesCents: 7, totalCostCents: 957, remainingOpenFeesCents: 7, remainingOpenCostCents: 957 }), {
      kalshiYesBidCents: kalshiResolution.yesBidCents,
      kalshiNoBidCents: kalshiResolution.noBidCents,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-11T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: kalshiResolution.resolved,
      pmResolved: true,
    });

    expect(result.status).toBe('settled');
    expect(result.settlementSide).toBe('kalshi');
    expect(result.realizedPnlCents).toBe(43);
  });
});

describe('BotPositionStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('persists separate executions for repeated buys in the same market pair', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1), (8, 1)`);
    client.close();

    const store = new BotPositionStore(dbUrl);
    const created = await store.create({
      executionId: 7,
      marketId: 'pair-1',
      marketTitle: 'Test market',
      kalshiTicker: 'KXTEST',
      pmConditionId: '0xabc',
      strategy: 'Buy YES Kalshi + NO PM',
      kalshiSide: 'yes',
      pmSide: 'no',
      buyPriceKalshiCents: 45,
      buyPricePmCents: 50,
      sharesKalshi: 10,
      sharesPm: 10,
      totalCostCents: 950,
      expectedPayoutCents: 1000,
      expectedProfitCents: 50,
      expectedRoiBps: 526,
      expectedApyBps: null,
      unitId: 'execution:7',
      feesCents: 0,
      category: 'Politics',
      pmTheta: 0.04,
      kalshiEntryFeeCents: 0,
      pmEntryFeeCents: 0,
      openedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      selectionMethod: 'hybrid',
    });

    expect(created.currentValueCents).toBe(1000);
    expect(created.unrealizedPnlCents).toBe(50);
    expect(created.dryRun).toBe(true);
    expect(created.selectionMethod).toBe('hybrid');
    await expect(store.create({
      ...created,
      id: undefined,
      executionId: 9,
      feesCents: 1,
      kalshiEntryFeeCents: 0.5,
      pmEntryFeeCents: 0.5,
      totalCostCents: 951,
      expectedProfitCents: 49,
    } as never)).rejects.toThrow(/integer cents/i);
    const second = await store.create({
      ...created,
      id: undefined,
      executionId: 8,
      buyPriceKalshiCents: 40,
      buyPricePmCents: 50,
      totalCostCents: 900,
      expectedProfitCents: 100,
      openedAt: '2026-08-08T12:05:00.000Z',
    } as never);
    expect(second.id).not.toBe(created.id);
    expect((await store.list({ status: 'open', limit: 10 })).map((row) => row.executionId)).toEqual([8, 7]);

    const columnsClient = createClient({ url: dbUrl });
    const columns = await columnsClient.execute('PRAGMA table_info(bot_positions)');
    columnsClient.close();
    expect(columns.rows.map((row) => String(row.name))).toEqual(expect.arrayContaining([
      'execution_id', 'buy_price_kalshi', 'buy_price_pm', 'current_value',
      'unrealized_pnl', 'unrealized_roi_pct', 'realized_pnl', 'settlement_side', 'selection_method',
      'live_shares_kalshi', 'live_shares_pm', 'live_principal', 'live_fees', 'live_cost', 'closed_at',
    ]));
  });

  it('keeps immutable execution facts while partial and full reductions change only live exposure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1), (8, 1)`);
    client.close();

    const store = new BotPositionStore(dbUrl);
    const first = await store.create({
      ...openPosition(), id: undefined, dryRun: undefined,
      totalCostCents: 957, feesCents: 7, expectedProfitCents: 43,
      kalshiEntryFeeCents: 4, pmEntryFeeCents: 3,
    } as never);
    const second = await store.create({
      ...openPosition(), id: undefined, dryRun: undefined,
      executionId: 8, buyPriceKalshiCents: 40, buyPricePmCents: 50,
      totalCostCents: 905, feesCents: 5, expectedProfitCents: 95,
      kalshiEntryFeeCents: 3, pmEntryFeeCents: 2,
      openedAt: '2026-08-01T00:05:00.000Z',
    } as never);

    const partial = await store.reduceExposure(first.id, {
      expectedRemainingSharesKalshi: 10,
      expectedRemainingSharesPm: 10,
      expectedLastValuationAt: '2026-08-01T00:00:00.000Z',
      remainingSharesKalshi: 5,
      remainingSharesPm: 5,
      realizedPnlCents: 11,
      observedAt: '2026-08-02T00:00:00.000Z',
    });
    expect(partial).toMatchObject({
      executionId: 7,
      buyPriceKalshiCents: 45,
      buyPricePmCents: 50,
      sharesKalshi: 10,
      sharesPm: 10,
      totalCostCents: 957,
      remainingSharesKalshi: 5,
      remainingSharesPm: 5,
      remainingOpenPrincipalCents: 475,
      remainingOpenFeesCents: 4,
      remainingOpenCostCents: 479,
      realizedPnlCents: 11,
      status: 'open',
      closedAt: null,
    });

    let page = await store.listMarkets({ status: 'all', limit: 10 });
    expect(page.markets).toHaveLength(1);
    expect(page.markets[0]).toMatchObject({
      marketKey: 'market:pair-1',
      currentLiveStakeCents: 1384,
      liveStakeCents: 1384,
      status: 'open',
    });
    expect(page.markets[0].executions.map((execution) => execution.status)).toEqual(['open', 'partially_closed']);
    expect(page.markets[0].executions[1]).toMatchObject({
      executionId: 7,
      executedAt: '2026-08-01T00:00:00.000Z',
      executionPrincipalCents: 950,
      executionFeesCents: 7,
      executionBuyCostCents: 957,
      remainingOpenCostCents: 479,
    });

    await store.reduceExposure(second.id, {
      expectedRemainingSharesKalshi: 10,
      expectedRemainingSharesPm: 10,
      expectedLastValuationAt: '2026-08-01T00:05:00.000Z',
      remainingSharesKalshi: 0,
      remainingSharesPm: 0,
      realizedPnlCents: -5,
      observedAt: '2026-08-03T00:00:00.000Z',
    });
    store.close();

    const reloaded = new BotPositionStore(dbUrl);
    page = await reloaded.listMarkets({ status: 'all', limit: 10 });
    expect(page.markets[0].currentLiveStakeCents).toBe(479);
    expect(page.markets[0].executions[0]).toMatchObject({
      entryId: second.id,
      executionId: 8,
      status: 'closed',
      executionBuyCostCents: 905,
      remainingOpenCostCents: 0,
      closedAt: '2026-08-03T00:00:00.000Z',
    });
    expect(page.markets[0].executions[1]).toMatchObject({
      entryId: first.id,
      executionId: 7,
      status: 'partially_closed',
      executionBuyCostCents: 957,
      remainingOpenCostCents: 479,
    });
    const openPage = await reloaded.listMarkets({ status: 'open', limit: 10 });
    expect(openPage.markets[0].executions).toHaveLength(2);
    expect((await reloaded.listMarkets({ status: 'settled', limit: 10 })).marketCount).toBe(0);
    reloaded.close();
  });

  it('keeps legacy rows without identifiers in separate execution groups', async () => {
    const rows = [
      openPosition({ id: 1, executionId: 7, marketId: null, kalshiTicker: null, pmConditionId: null }),
      openPosition({ id: 2, executionId: 8, marketId: null, kalshiTicker: null, pmConditionId: null }),
    ];
    const groups = BotPositionStore.groupForAnalytics(rows);
    expect(groups.map((group) => group.marketKey)).toEqual(['legacy-execution:7', 'legacy-execution:8']);
  });

  it('does not aggregate an unavailable execution as a zero-dollar loss', () => {
    const groups = BotPositionStore.groupForAnalytics([
      openPosition({ id: 1, currentValueCents: 101, unrealizedPnlCents: 6 }),
      openPosition({ id: 2, executionId: 8, currentPriceKalshiCents: null, currentPricePmCents: null, currentValueCents: null, unrealizedPnlCents: null, lastValuationAt: null }),
    ]);
    expect(groups[0]).toMatchObject({ currentValueCents: 101, unrealizedPnlCents: 6, valuedExecutionCount: 1, unavailableExecutionCount: 1, valuedLiveStakeCents: 950 });
    expect(groups[0].executions.find((execution) => execution.executionId === 8)).toMatchObject({ currentValueCents: null, unrealizedPnlCents: null });
  });

  it('reports stale execution coverage and the oldest stored quote on the market summary', () => {
    const groups = BotPositionStore.groupForAnalytics([
      openPosition({ id: 1, executionId: 7, valuationStatus: 'current', lastValuationAt: '2026-08-12T18:00:00.000Z' }),
      openPosition({ id: 2, executionId: 8, valuationStatus: 'stale', lastValuationAt: '2026-08-12T17:30:00.000Z', valuationFailureReason: 'Kalshi HTTP 503' }),
      openPosition({ id: 3, executionId: 9, valuationStatus: 'stale', lastValuationAt: '2026-08-12T17:00:00.000Z', valuationFailureReason: 'Kalshi timeout' }),
    ]);

    expect(groups[0]).toMatchObject({
      valuedExecutionCount: 3,
      staleExecutionCount: 2,
      oldestStaleValuationAt: '2026-08-12T17:00:00.000Z',
    });
  });

  it('reconciles the House fixture from both executable held-side legs', () => {
    const house = openPosition({
      id: 131, executionId: 131, marketId: 'house-2026',
      marketTitle: 'Which party will win the House in 2026?',
      kalshiSide: 'yes', pmSide: 'no', sharesKalshi: 1, sharesPm: 1,
      remainingSharesKalshi: 1, remainingSharesPm: 1,
      remainingOpenPrincipalCents: 170, remainingOpenFeesCents: 2,
      remainingOpenCostCents: 172, totalCostCents: 172,
    });
    const valuation = calculatePositionValuation(house, {
      kalshiYesBidCents: 86, kalshiNoBidCents: 15,
      pmYesBidCents: 88, pmNoBidCents: 87,
      observedAt: '2026-08-12T18:08:00.000Z', expiryDate: null,
    });
    const [market] = BotPositionStore.groupForAnalytics([{ ...house, ...valuation }]);

    expect(valuation.legs.kalshi.netProceedsCents + valuation.legs.polymarket.netProceedsCents).toBe(valuation.currentValueCents);
    expect(market).toMatchObject({ currentValueCents: valuation.currentValueCents, unrealizedPnlCents: valuation.currentValueCents - 172, valuedExecutionCount: 1, unavailableExecutionCount: 0 });
    expect(market.currentValueCents).not.toBe(0);
  });

  it('reconciles all seven OpenAI executions and reports unavailable children separately', () => {
    const executions = Array.from({ length: 7 }, (_, index) => {
      const cost = 94 + index;
      const value = 90 + index;
      return openPosition({
        id: 200 + index, executionId: 200 + index,
        marketId: 'openai-product-2026',
        marketTitle: 'What kind of product will OpenAI announce in 2026?',
        remainingOpenCostCents: cost, totalCostCents: cost,
        currentValueCents: index === 6 ? null : value,
        unrealizedPnlCents: index === 6 ? null : value - cost,
        currentPriceKalshiCents: index === 6 ? null : 45,
        currentPricePmCents: index === 6 ? null : 50,
        lastValuationAt: index === 6 ? null : '2026-08-12T18:08:00.000Z',
      });
    });
    const [market] = BotPositionStore.groupForAnalytics(executions);
    const valued = executions.slice(0, 6);

    expect(market.currentValueCents).toBe(valued.reduce((sum, row) => sum + (row.currentValueCents as number), 0));
    expect(market.unrealizedPnlCents).toBe(valued.reduce((sum, row) => sum + (row.unrealizedPnlCents as number), 0));
    expect(market.valuedLiveStakeCents).toBe(valued.reduce((sum, row) => sum + row.remainingOpenCostCents, 0));
    expect(market).toMatchObject({ valuedExecutionCount: 6, unavailableExecutionCount: 1 });
  });

  it('backfills and returns a legacy single-entry row after reload', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-legacy-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1)`);
    await client.execute(`CREATE TABLE bot_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id INTEGER,
      market_title TEXT NOT NULL,
      buy_price_kalshi INTEGER NOT NULL,
      buy_price_pm INTEGER NOT NULL,
      shares_kalshi INTEGER NOT NULL,
      shares_pm INTEGER NOT NULL,
      total_cost INTEGER NOT NULL,
      fees INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TEXT NOT NULL
    )`);
    await client.execute(`INSERT INTO bot_positions (
      execution_id, market_title, buy_price_kalshi, buy_price_pm,
      shares_kalshi, shares_pm, total_cost, fees, status, opened_at
    ) VALUES (7, 'Legacy title', 45, 50, 10, 10, 957, 7, 'open', '2026-08-01T00:00:00.000Z')`);
    client.close();

    const store = new BotPositionStore(dbUrl);
    const page = await store.listMarkets({ status: 'all', limit: 10 });
    expect(page.markets).toHaveLength(1);
    expect(page.markets[0]).toMatchObject({
      marketKey: 'legacy-execution:7',
      currentLiveStakeCents: 957,
      latestExecutionAt: '2026-08-01T00:00:00.000Z',
    });
    expect(page.markets[0].executions[0]).toMatchObject({
      executionId: 7,
      executionPrincipalCents: 950,
      executionFeesCents: 7,
      executionBuyCostCents: 957,
      remainingOpenCostCents: 957,
      unitId: 'execution:7',
      status: 'open',
    });
    expect(page.markets[0].executions[0].legs.reduce((sum, leg) => sum + leg.entryFeeCents, 0)).toBe(7);
    store.close();
  });

  it('atomically reserves a normalized venue pair across concurrent clients', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    client.close();
    const first = new BotPositionStore(dbUrl);
    const second = new BotPositionStore(dbUrl);

    const results = await Promise.all([
      first.reservePair('KXTEST', '0xAbC'),
      second.reservePair('kxtest', '0xabc'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    await first.releasePair('KXTEST', '0xABC');
    await expect(second.reservePair('kxtest', '0xabc')).resolves.toBe(true);
    first.close();
    second.close();
  });

  it('does not expire a reservation protecting known unpersisted exposure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    client.close();
    const store = new BotPositionStore(dbUrl);

    await expect(store.reservePair('KXTEST', '0xabc')).resolves.toBe(true);
    await store.retainPairForExposure('KXTEST', '0xabc');
    const agingClient = createClient({ url: dbUrl });
    await agingClient.execute(`UPDATE bot_position_reservations SET reserved_at = '2000-01-01T00:00:00.000Z'`);
    agingClient.close();

    await expect(store.reservePair('kxtest', '0xABC')).resolves.toBe(false);
    store.close();
  });

  it('updates a persisted open position with valuation and settlement output', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 0)`);
    client.close();
    const store = new BotPositionStore(dbUrl);
    const created = await store.create({
      ...openPosition(),
      id: undefined,
      dryRun: undefined,
    } as never);

    const valuation = calculatePositionValuation(created, {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    });
    await store.updateValuation(created.id, valuation);

    const [stored] = await store.list({ status: 'open', limit: 10 });
    expect(stored.currentValueCents).toBe(1022);
    expect(stored.unrealizedPnlCents).toBe(72);
    expect(stored.dryRun).toBe(false);

    const settlement = calculatePositionValuation(stored, {
      kalshiYesBidCents: 100,
      kalshiNoBidCents: 0,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-11T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: true,
      pmResolved: true,
    });
    await store.updateValuation(created.id, settlement);
    const [settled] = await store.list({ status: 'settled', limit: 10 });
    expect(settled).toMatchObject({
      sharesKalshi: 10,
      sharesPm: 10,
      totalCostCents: 950,
      remainingSharesKalshi: 0,
      remainingSharesPm: 0,
      remainingOpenPrincipalCents: 0,
      remainingOpenFeesCents: 0,
      remainingOpenCostCents: 0,
      currentValueCents: 0,
      unrealizedPnlCents: 0,
      realizedPnlCents: 50,
      status: 'settled',
    });
  });

  it('retains the latest successful snapshot and records a later refresh failure as stale', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1)`);
    client.close();
    const store = new BotPositionStore(dbUrl);
    const created = await store.create({ ...openPosition(), id: undefined, dryRun: undefined } as never);
    const valuation = calculatePositionValuation(created, {
      kalshiYesBidCents: 48, kalshiNoBidCents: 51, pmYesBidCents: 42, pmNoBidCents: 57,
      observedAt: '2026-08-08T12:00:00.000Z', expiryDate: null,
    });
    await store.updateValuation(created.id, valuation);
    await store.recordValuationFailure(created.id, 'Polymarket order book unavailable', '2026-08-08T12:01:00.000Z');

    const stored = await store.getById(created.id);
    expect(stored).toMatchObject({
      currentValueCents: 1022,
      lastValuationAt: '2026-08-08T12:00:00.000Z',
      valuationStatus: 'stale',
      valuationFailureReason: 'Polymarket order book unavailable',
      valuationFailureAt: '2026-08-08T12:01:00.000Z',
      kalshiValuationDepth: 10,
      pmValuationDepth: 10,
      kalshiQuoteSource: 'kalshi_orderbook',
      pmQuoteSource: 'polymarket_clob_book',
    });
    store.close();
  });

  it('fences successful and failed valuation writes by observation time', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1)`);
    client.close();
    const store = new BotPositionStore(dbUrl);
    const created = await store.create({ ...openPosition(), id: undefined, dryRun: undefined } as never);
    const valuationAt = (observedAt: string, kalshiYesBidCents: number) => calculatePositionValuation(created, {
      kalshiYesBidCents, kalshiNoBidCents: 100 - kalshiYesBidCents,
      pmYesBidCents: 42, pmNoBidCents: 57, observedAt, expiryDate: null,
    });

    await store.updateValuation(created.id, valuationAt('2026-08-08T12:02:00.000Z', 60));
    await store.updateValuation(created.id, valuationAt('2026-08-08T12:01:00.000Z', 40));
    await store.recordValuationFailure(created.id, 'older upstream failure', '2026-08-08T12:01:30.000Z');
    let stored = await store.getById(created.id);
    expect(stored).toMatchObject({ lastValuationAt: '2026-08-08T12:02:00.000Z', currentPriceKalshiCents: 60, valuationStatus: 'current', valuationFailureReason: null });

    await store.recordValuationFailure(created.id, 'newer upstream failure', '2026-08-08T12:03:00.000Z');
    stored = await store.getById(created.id);
    expect(stored).toMatchObject({ lastValuationAt: '2026-08-08T12:02:00.000Z', currentPriceKalshiCents: 60, valuationStatus: 'stale', valuationFailureReason: 'newer upstream failure' });
    store.close();
  });
});

describe('pollOpenBotPositions', () => {
  it('fetches and maps the authenticated Kalshi dollar order-book ladder', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orderbook_fp: { yes_dollars: [['0.48', '1'], ['0.47', '2.5']], no_dollars: [['0.51', '4']] } }),
    });
    const makeHeaders = vi.fn().mockReturnValue({ Authorization: 'signed' });

    await expect(fetchKalshiBidLevels('KX TEST/26', { fetchImpl: fetchImpl as never, makeHeaders })).resolves.toEqual({
      yesBidLevels: [{ priceCents: 48, quantity: 1 }, { priceCents: 47, quantity: 2.5 }],
      noBidLevels: [{ priceCents: 51, quantity: 4 }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://external-api.kalshi.com/trade-api/v2/markets/KX%20TEST%2F26/orderbook',
      expect.objectContaining({ headers: { Authorization: 'signed' }, cache: 'no-store' }),
    );
    expect(makeHeaders).toHaveBeenCalledWith('GET', '/trade-api/v2/markets/KX%20TEST%2F26/orderbook');
  });

  it('liquidates a held Kalshi leg across the full order-book ladder', async () => {
    const updateValuation = vi.fn().mockResolvedValue(undefined);
    const result = await pollOpenBotPositions({
      positionStore: {
        listAllOpen: vi.fn().mockResolvedValue([openPosition({ id: 401, remainingSharesKalshi: 3, remainingSharesPm: 3, remainingOpenCostCents: 285 })]),
        updateValuation,
        recordValuationFailure: vi.fn().mockResolvedValue(undefined),
      },
      fetchKalshi: vi.fn().mockResolvedValue({ yes_bid_dollars: '0.48', no_bid_dollars: '0.51' }),
      fetchKalshiBids: vi.fn().mockResolvedValue({
        yesBidLevels: [{ priceCents: 48, quantity: 1 }, { priceCents: 47, quantity: 2 }],
        noBidLevels: [{ priceCents: 51, quantity: 10 }],
      }),
      fetchPmBids: vi.fn().mockResolvedValue({
        yesBidCents: 42, noBidCents: 57, resolved: false,
        yesBidLevels: [{ priceCents: 42, quantity: 3 }],
        noBidLevels: [{ priceCents: 57, quantity: 3 }],
      }),
      observedAt: '2026-08-12T18:08:00.000Z',
    });

    expect(result.errors).toEqual([]);
    expect(updateValuation).toHaveBeenCalledOnce();
    expect(updateValuation.mock.calls[0][1].legs.kalshi).toMatchObject({ executableDepthUsed: 3, grossProceedsCents: 142 });
  });

  it('records specific missing-id, upstream, and partial-leg failures without overwriting snapshots', async () => {
    const positions = [
      openPosition({ id: 301, kalshiTicker: null }),
      openPosition({ id: 302, kalshiTicker: 'KXUPSTREAM', pmConditionId: 'upstream' }),
      openPosition({ id: 303, kalshiTicker: 'KXPARTIAL', pmConditionId: 'partial' }),
    ];
    const updateValuation = vi.fn().mockResolvedValue(undefined);
    const recordValuationFailure = vi.fn().mockResolvedValue(undefined);
    const result = await pollOpenBotPositions({
      positionStore: {
        listAllOpen: vi.fn().mockResolvedValue(positions),
        updateValuation,
        recordValuationFailure,
      },
      fetchKalshi: vi.fn(async (ticker) => ticker === 'KXUPSTREAM' ? null : ({ yes_bid_dollars: '0.48', no_bid_dollars: '0.51' })),
      fetchPmBids: vi.fn(async (conditionId) => conditionId === 'partial'
        ? { yesBidCents: null, noBidCents: null, resolved: false }
        : { yesBidCents: 42, noBidCents: 57, resolved: false }),
      observedAt: '2026-08-12T18:08:00.000Z',
    });

    expect(updateValuation).not.toHaveBeenCalled();
    expect(result.errors).toEqual([
      { id: 301, error: 'Position is missing venue market identifiers' },
      { id: 302, error: 'Venue quote unavailable' },
      { id: 303, error: 'Missing executable bid for bot position 303' },
    ]);
    expect(recordValuationFailure).toHaveBeenCalledTimes(3);
  });
});
