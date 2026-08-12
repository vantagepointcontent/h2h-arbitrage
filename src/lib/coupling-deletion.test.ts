import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coupling-delete-'));
const originalCwd = process.cwd();

let manualMatches: typeof import('./manual-matches');
let decoupledPairs: typeof import('./decoupled-pairs');
let persistence: typeof import('./persistence');
let couplingStore: typeof import('./coupling-store');

const kalshiTicker = 'kx-test-team';
const pmConditionId = '0xABCDEF';

function positiveScan(overrides: Partial<import('./persistence').LastScanResult> = {}): import('./persistence').LastScanResult {
  return {
    bestRoiPct: 8.3,
    bestProfit: 83,
    strategy: 'Buy YES Kalshi + NO PM',
    outcomeCount: 2,
    matchedCount: 1,
    kalshiCount: 1,
    pmCount: 1,
    scannedAt: new Date().toISOString(),
    allArbs: [{
      artist: 'Test Team',
      roiPct: 8.3,
      expectedProfit: 83,
      strategy: 'Buy YES Kalshi + NO PM',
      arbType: 'direct',
      kalshiTicker: kalshiTicker.toUpperCase(),
      pmConditionId: pmConditionId.toLowerCase(),
      apyPct: 23.6,
    }],
    ...overrides,
  };
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  process.chdir(tmpDir);
  vi.resetModules();
  manualMatches = await import('./manual-matches');
  decoupledPairs = await import('./decoupled-pairs');
  persistence = await import('./persistence');
  couplingStore = await import('./coupling-store');
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('durable coupling deletion tombstones', () => {
  it('uses one stable identity across mixed case and surrounding whitespace', () => {
    expect(couplingStore.couplingKey(' kx-test-team ', ' 0xABCDEF ')).toBe(
      couplingStore.couplingKey('KX-TEST-TEAM', '0xabcdef'),
    );
  });
  it('tombstones a deleted manual match, invalidates current derivatives, and is idempotent', async () => {
    const saved = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/KXTEST',
      polymarketUrl: 'https://polymarket.com/event/test',
      eventTitle: 'Test',
      category: 'Sports',
      expiryDate: null,
    });
    await persistence.updateSavedMarketScanResult(saved.id, positiveScan());
    await persistence.updateSavedMarketLiveResult(saved.id, positiveScan());

    const db = createClient({ url: `file:${path.join(tmpDir, 'data', 'edgefinder.db')}` });
    await db.execute(`CREATE TABLE IF NOT EXISTS watch_targets (
      pair_id TEXT NOT NULL, kalshi_ticker TEXT NOT NULL, pm_yes_token TEXT NOT NULL,
      pm_no_token TEXT NOT NULL, pm_condition_id TEXT, artist TEXT NOT NULL DEFAULT '',
      category TEXT, resolved_at TEXT NOT NULL, PRIMARY KEY (pair_id, kalshi_ticker)
    )`);
    await db.execute({
      sql: `INSERT INTO watch_targets
        (pair_id, kalshi_ticker, pm_yes_token, pm_no_token, pm_condition_id, artist, resolved_at)
        VALUES (?, ?, 'yes', 'no', ?, 'Test Team', ?)`,
      args: [saved.id, kalshiTicker.toUpperCase(), pmConditionId.toLowerCase(), new Date().toISOString()],
    });

    const unrelated = await manualMatches.addManualMatch({
      kalshiTicker: 'KX-OTHER', pmConditionId: '0xother', kalshiTitle: 'Other', pmTitle: 'Other',
    });
    const target = await manualMatches.addManualMatch({
      kalshiTicker, pmConditionId, kalshiTitle: 'Test Team', pmTitle: 'Test Team',
    });

    expect(await manualMatches.deleteManualMatch(target.id)).toBe(true);
    expect(await manualMatches.deleteManualMatch(target.id)).toBe(true);

    const tombstones = await decoupledPairs.getDecoupledPairs();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      couplingKey: 'v1:kalshi:KX-TEST-TEAM|polymarket:0xabcdef',
      kalshiTicker: kalshiTicker.toUpperCase(),
      pmConditionId: pmConditionId.toLowerCase(),
      manualMatchId: target.id,
    });
    expect((await manualMatches.getManualMatches()).map((m) => m.id)).toEqual([unrelated.id]);

    const stored = await persistence.getSavedMarketById(saved.id);
    expect(stored?.lastScanResult).toBeNull();
    expect(stored?.liveResult).toBeNull();
    const targets = await db.execute('SELECT * FROM watch_targets');
    expect(targets.rows).toHaveLength(0);
    const persisted = await db.execute(`SELECT state, revision FROM coupling_states WHERE coupling_key = ?`, [tombstones[0].couplingKey]);
    expect(persisted.rows[0]).toMatchObject({ state: 'deleted', revision: 1 });

    const autoMatched = [{
      artist: 'Test Team',
      kalshi: { ticker: kalshiTicker.toUpperCase() },
      polymarket: { conditionId: pmConditionId.toLowerCase(), marketId: 'pm-market' },
      arbitrage: { strategy: 'DIRECT', expectedProfit: 83, roiPct: 8.3, apyPct: 23.6 },
    }];
    const filtered = decoupledPairs.applyDecoupledPairs(autoMatched, tombstones);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((outcome) => !(outcome.kalshi && outcome.polymarket))).toBe(true);
  });

  it('allows only an explicit manual create to clear the tombstone', async () => {
    const recreated = await manualMatches.addManualMatch({
      kalshiTicker: kalshiTicker.toUpperCase(),
      pmConditionId: pmConditionId.toLowerCase(),
      kalshiTitle: 'Test Team',
      pmTitle: 'Test Team',
    });
    expect(recreated.id).toBeTruthy();
    expect(await decoupledPairs.getDecoupledPairs()).toEqual([]);
  });

  it('rejects stale scan and live writes that race a tombstone', async () => {
    const saved = (await persistence.getSavedMarkets())[0];
    await decoupledPairs.addDecoupledPair({
      kalshiTicker,
      pmConditionId,
      kalshiTitle: 'Test Team',
      pmTitle: 'Test Team',
    });

    await persistence.updateSavedMarketScanResult(saved.id, positiveScan());
    await persistence.updateSavedMarketLiveResult(saved.id, positiveScan());

    const stored = await persistence.getSavedMarketById(saved.id);
    expect(stored?.lastScanResult?.allArbs).toEqual([]);
    expect(stored?.lastScanResult?.bestRoiPct).toBe(0);
    expect(stored?.liveResult?.allArbs).toEqual([]);
    expect(stored?.liveResult?.bestRoiPct).toBe(0);
  });
});
