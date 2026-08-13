import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbPath = `/tmp/h2h-watcher-publication-${process.pid}.db`;
vi.hoisted(() => {
  process.env.H2H_SQLITE_PATH = `/tmp/h2h-watcher-publication-${process.pid}.db`;
  process.env.H2H_SAVED_MARKETS_FILE = `/tmp/h2h-watcher-publication-${process.pid}.json`;
});

import { promises as fs } from 'fs';
import * as persistence from './persistence';
import { mutateManualCoupling } from './coupling-store';
import { reserveWatcherMatchPublication } from './watcher-match-publication';

beforeEach(async () => {
  await Promise.all([
    fs.rm(dbPath, { force: true }),
    fs.rm(`${dbPath}-shm`, { force: true }),
    fs.rm(`${dbPath}-wal`, { force: true }),
    fs.rm(process.env.H2H_SAVED_MARKETS_FILE!, { force: true }),
  ]);
});

afterEach(async () => {
  await Promise.all([
    fs.rm(dbPath, { force: true }),
    fs.rm(`${dbPath}-shm`, { force: true }),
    fs.rm(`${dbPath}-wal`, { force: true }),
    fs.rm(process.env.H2H_SAVED_MARKETS_FILE!, { force: true }),
  ]);
});

describe('watcher canonical publication boundary', () => {
  it('rejects a result captured before a manual coupling is deleted during compute', async () => {
    // The persistence module owns a process-wide SQLite connection. Other full-suite
    // tests can initialize it before this file's cleanup hooks run, so use a unique
    // fixture identity instead of colliding with a prior retained fixture row.
    const fixtureId = `watcher-${process.pid}-${Date.now()}`;
    const market = await persistence.addSavedMarket({
      kalshiUrl: `https://kalshi.com/markets/${fixtureId}`,
      polymarketUrl: `https://polymarket.com/event/${fixtureId}`,
      eventTitle: `Watcher fence ${fixtureId}`, category: '', expiryDate: null,
    });
    const manualMatchId = 'watcher-manual';
    await mutateManualCoupling({
      action: 'create', marketId: market.id, manualMatchId,
      kalshiTicker: 'WATCH-D', pmConditionId: 'watch-d', artist: 'Democratic',
      manualMatch: {
        id: manualMatchId, marketId: market.id, kalshiTicker: 'WATCH-D',
        pmConditionId: 'watch-d', kalshiTitle: 'Democratic', pmTitle: 'Democratic',
        createdAt: new Date().toISOString(),
      },
    });

    const captured = await reserveWatcherMatchPublication(market.id, [{
      artist: 'Democratic', kalshiTicker: 'WATCH-D', pmConditionId: 'watch-d',
    }]);
    expect(captured).not.toBeNull();

    await mutateManualCoupling({
      action: 'delete', marketId: market.id, manualMatchId,
      kalshiTicker: 'WATCH-D', pmConditionId: 'watch-d', artist: 'Democratic',
    });
    await persistence.updateSavedMarketLiveResult(market.id, {
      bestRoiPct: 0, bestProfit: 0, strategy: 'No arb', outcomeCount: 1,
      matchedCount: 1, matchStatus: 'matched', matchedPairs: captured!.matchedPairs,
      matchDependencies: captured!.matchDependencies, publicationGeneration: captured!.publicationGeneration,
      kalshiCount: 1, pmCount: 1, scannedAt: new Date().toISOString(), allArbs: [],
    });

    // The stale watcher publication is rejected. With no prior live result,
    // deletion intentionally leaves the live channel empty rather than
    // resurrecting the captured pair.
    expect((await persistence.getSavedMarketById(market.id))?.liveResult).toBeNull();
  });
});
