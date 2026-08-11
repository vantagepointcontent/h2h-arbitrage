import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BotPositionStore,
  calculateBotPositionEntryCost,
  calculatePositionValuation,
  createBotPosition,
  getKalshiResolvedPrices,
  pollOpenBotPositions,
  type BotPosition,
} from './bot-positions';
import { calcKalshiFee, calcPolymarketFee } from './matcher';

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
    totalCostCents: 950,
    expectedPayoutCents: 1000,
    expectedProfitCents: 50,
    feesCents: 0,
    category: 'Politics',
    pmTheta: 0.04,
    kalshiEntryFeeCents: 0,
    pmEntryFeeCents: 0,
    status: 'open',
    openedAt: '2026-08-01T00:00:00.000Z',
    expiryDate: '2026-08-10T00:00:00.000Z',
    settledAt: null,
    currentPriceKalshiCents: 45,
    currentPricePmCents: 55,
    currentValueCents: 1000,
    unrealizedPnlCents: 50,
    unrealizedRoiBps: 526,
    lastValuationAt: '2026-08-01T00:00:00.000Z',
    realizedPnlCents: null,
    settlementSide: null,
    dryRun: true,
    ...overrides,
  };
}

describe('calculatePositionValuation', () => {
  it('marks an open YES-Kalshi/NO-PM position to executable sell bids using integer cents', () => {
    const result = calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids: [{ priceCents: 48, size: 10 }],
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    });

    expect(result).toEqual({
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

  it('liquidates the full held quantity through both bid ladders and subtracts exit fees on both legs', () => {
    const result = calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 50,
      kalshiNoBidCents: 45,
      pmYesBidCents: 45,
      pmNoBidCents: 55,
      kalshiYesBids: [{ priceCents: 50.5, size: 5 }, { priceCents: 40.5, size: 5 }],
      kalshiNoBids: [{ priceCents: 45, size: 10 }],
      pmYesBids: [{ priceCents: 45, size: 10 }],
      pmNoBids: [{ priceCents: 55, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    });

    const expectedExitFeesCents = Math.round((
      calcKalshiFee(5, 0.505)
      + calcKalshiFee(5, 0.405)
      + calcPolymarketFee(10, 0.55, 0.04)
    ) * 100);
    expect(result.currentPriceKalshiCents).toBe(46);
    expect(result.currentPricePmCents).toBe(55);
    expect(result.currentValueCents).toBe(1005 - expectedExitFeesCents);
    expect(result.unrealizedPnlCents).toBe(result.currentValueCents - 950);
    expect(result.unrealizedRoiBps).toBe(Math.round((result.unrealizedPnlCents * 10_000) / 950));
  });

  it('fails closed when top bids exist but authoritative executable ladders are missing', () => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/executable bid depth unavailable/i);
  });

  it.each([
    { levels: [{ priceCents: 48, size: 10 }, { priceCents: Number.NaN, size: 1 }] },
    { levels: [{ priceCents: 48, size: 10 }, { priceCents: 47, size: -1 }] },
    { levels: [{ priceCents: 48, size: 10 }, { priceCents: 101, size: 1 }] },
  ])('rejects an entire mixed valid and malformed executable ladder ($levels)', ({ levels: kalshiYesBids }) => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids,
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/malformed executable bid depth/i);
  });

  it('rejects duplicate normalized prices instead of silently combining or discarding levels', () => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids: [{ priceCents: 48, size: 5 }, { priceCents: 48, size: 5 }],
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/duplicate executable bid price/i);
  });

  it('reports a loss from executable proceeds below the fee-inclusive buy cost', () => {
    const result = calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 40,
      kalshiNoBidCents: 60,
      pmYesBidCents: 50,
      pmNoBidCents: 50,
      kalshiYesBids: [{ priceCents: 40, size: 10 }],
      kalshiNoBids: [{ priceCents: 60, size: 10 }],
      pmYesBids: [{ priceCents: 50, size: 10 }],
      pmNoBids: [{ priceCents: 50, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    });
    expect(result.currentValueCents).toBeLessThan(950);
    expect(result.unrealizedPnlCents).toBe(result.currentValueCents - 950);
    expect(result.unrealizedRoiBps).toBeLessThan(0);
  });

  it('fails closed when either held leg lacks enough executable bid depth', () => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids: [{ priceCents: 48, size: 9 }],
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/insufficient executable bid depth/i);
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
    const result = calculatePositionValuation(openPosition({ feesCents: 7, totalCostCents: 957 }), {
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
      kalshiYesBids: [{ priceCents: 100, size: 10 }],
      kalshiNoBids: [{ priceCents: 1, size: 10 }],
      pmYesBids: [{ priceCents: 1, size: 10 }],
      pmNoBids: [{ priceCents: 100, size: 10 }],
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

    const result = calculatePositionValuation(openPosition({ feesCents: 7, totalCostCents: 957 }), {
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

describe('calculateBotPositionEntryCost', () => {
  it('persists Buy Cost as both acquisition legs plus both entry execution fees', () => {
    const result = calculateBotPositionEntryCost({
      buyPriceKalshiCents: 45.1,
      buyPricePmCents: 50,
      sharesKalshi: 10,
      sharesPm: 10,
      pmTheta: 0.04,
    });
    const expectedKalshiFee = Math.round(calcKalshiFee(10, 0.451) * 100);
    const expectedPmFee = Math.round(calcPolymarketFee(10, 0.50, 0.04) * 100);
    expect(result.kalshiEntryFeeCents).toBe(expectedKalshiFee);
    expect(result.pmEntryFeeCents).toBe(expectedPmFee);
    expect(result.totalCostCents).toBe(451 + 500 + expectedKalshiFee + expectedPmFee);
  });
});

describe('BotPositionStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('creates the full table without inventing an executable mark and prevents duplicate open pairs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1)`);
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
      feesCents: 0,
    category: 'Politics',
    pmTheta: 0.04,
    kalshiEntryFeeCents: 0,
    pmEntryFeeCents: 0,
      openedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      selectionMethod: 'hybrid',
    });

    expect(created.currentPriceKalshiCents).toBeNull();
    expect(created.currentPricePmCents).toBeNull();
    expect(created.currentValueCents).toBeNull();
    expect(created.unrealizedPnlCents).toBeNull();
    expect(created.unrealizedRoiBps).toBeNull();
    expect(created.lastValuationAt).toBeNull();
    expect(created.dryRun).toBe(true);
    expect(created.selectionMethod).toBe('hybrid');
    await expect(store.hasOpenPair('KXTEST', '0xabc')).resolves.toBe(true);
    await expect(store.create({ ...created, id: undefined } as never)).rejects.toThrow(/open bot position/i);

    const columnsClient = createClient({ url: dbUrl });
    const columns = await columnsClient.execute('PRAGMA table_info(bot_positions)');
    columnsClient.close();
    expect(columns.rows.map((row) => String(row.name))).toEqual(expect.arrayContaining([
      'execution_id', 'buy_price_kalshi', 'buy_price_pm', 'current_value',
      'unrealized_pnl', 'unrealized_roi_pct', 'realized_pnl', 'settlement_side', 'selection_method',
    ]));
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
      kalshiYesBids: [{ priceCents: 48, size: 10 }],
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    });
    await store.updateValuation(created.id, valuation);
    await store.clearOpenValuation(created.id, '2026-08-08T11:59:00.000Z');
    await store.updateValuation(created.id, {
      ...valuation,
      currentValueCents: 1,
      unrealizedPnlCents: -949,
      lastValuationAt: '2026-08-08T11:58:00.000Z',
    });

    const [stored] = await store.list({ status: 'open', limit: 10 });
    expect(stored.currentValueCents).toBe(1022);
    expect(stored.unrealizedPnlCents).toBe(72);
    expect(stored.dryRun).toBe(false);
  });
});

describe('pollOpenBotPositions fail-closed valuation', () => {
  it('clears prior marks at each malformed, shallow, or stale depth observation timestamp', async () => {
    const previousCwd = process.cwd();
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-poller-'));
    try {
      process.chdir(dir);
      await mkdir(path.join(dir, 'data'));
      const dbUrl = `file:${path.join(dir, 'data', 'edgefinder.db')}`;
      const client = createClient({ url: dbUrl });
      await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
      await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1)`);
      client.close();
      const created = await createBotPosition({
        ...openPosition(),
        id: undefined,
        dryRun: undefined,
      } as never);

      const runAttempt = async (
        attemptedAt: string,
        kalshiYesBids: Array<{ priceCents: number; size: number }>,
        depthObservedAt = attemptedAt,
      ) => pollOpenBotPositions({
        observedAt: attemptedAt,
        fetchKalshi: async () => ({
          yes_bid_dollars: '0.48',
          no_bid_dollars: '0.51',
          close_time: '2026-08-10T00:00:00.000Z',
          status: 'open',
        }),
        fetchKalshiBids: async () => ({
          yesBids: kalshiYesBids,
          noBids: [{ priceCents: 51, size: 10 }],
          observedAt: depthObservedAt,
        }),
        fetchPmBids: async () => ({
          yesBidCents: 42,
          noBidCents: 57,
          yesBids: [{ priceCents: 42, size: 10 }],
          noBids: [{ priceCents: 57, size: 10 }],
          resolved: false,
          observedAt: attemptedAt,
        }),
      });
      const setPriorMark = async () => {
        const db = createClient({ url: dbUrl });
        await db.execute({
          sql: `UPDATE bot_positions SET current_price_kalshi = 48, current_price_pm = 57,
            current_value = 1000, unrealized_pnl = 50, unrealized_roi_pct = 526 WHERE id = ?`,
          args: [created.id],
        });
        db.close();
      };
      const expectClearedAt = async (attemptedAt: string) => {
        const db = createClient({ url: dbUrl });
        const row = (await db.execute({ sql: 'SELECT * FROM bot_positions WHERE id = ?', args: [created.id] })).rows[0];
        db.close();
        expect(row.current_price_kalshi).toBeNull();
        expect(row.current_price_pm).toBeNull();
        expect(row.current_value).toBeNull();
        expect(row.unrealized_pnl).toBeNull();
        expect(row.unrealized_roi_pct).toBeNull();
        expect(row.last_valuation_at).toBe(attemptedAt);
      };

      await setPriorMark();
      await expect(runAttempt('2026-08-08T12:00:00.000Z', [
        { priceCents: 48, size: 10 },
        { priceCents: Number.NaN, size: 1 },
      ])).resolves.toMatchObject({ updated: 0, errors: [{ id: created.id }] });
      await expectClearedAt('2026-08-08T12:00:00.000Z');

      await setPriorMark();
      await expect(runAttempt('2026-08-08T12:01:00.000Z', [{ priceCents: 48, size: 9 }]))
        .resolves.toMatchObject({ updated: 0, errors: [{ id: created.id }] });
      await expectClearedAt('2026-08-08T12:01:00.000Z');

      await setPriorMark();
      await expect(runAttempt(
        '2026-08-08T12:02:00.000Z',
        [{ priceCents: 48, size: 10 }],
        '2026-08-08T12:00:00.000Z',
      )).resolves.toMatchObject({ updated: 0, errors: [{ id: created.id }] });
      await expectClearedAt('2026-08-08T12:02:00.000Z');
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
