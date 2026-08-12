// WS-107: watcher-written liveResult — persistence + TTL fallback tests.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Run against an isolated temp DB (persistence.ts resolves data/edgefinder.db
// from process.cwd()).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws107-'));
const origCwd = process.cwd();

let persistence: typeof import('./persistence');

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  process.chdir(tmpDir);
  vi.resetModules();
  persistence = await import('./persistence');
});

afterAll(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeScan(overrides: Partial<import('./persistence').LastScanResult> = {}) {
  return {
    bestRoiPct: 5.5,
    bestProfit: 55,
    strategy: 'Buy YES Kalshi + NO PM',
    outcomeCount: 4,
    matchedCount: 3,
    kalshiCount: 4,
    pmCount: 4,
    scannedAt: new Date().toISOString(),
    allArbs: [{ artist: 'A', roiPct: 5.5, expectedProfit: 55, strategy: 'Buy YES Kalshi + NO PM' }],
    ...overrides,
  };
}

describe('WS-107 liveResult persistence', () => {
  it('uses the safe TTL when the live-result environment value is invalid', () => {
    expect(persistence.parseLiveResultTtlMs('not-a-duration')).toBe(10 * 60_000);
    expect(persistence.parseLiveResultTtlMs('0')).toBe(10 * 60_000);
    expect(persistence.parseLiveResultTtlMs('-1')).toBe(10 * 60_000);
    expect(persistence.parseLiveResultTtlMs('300000')).toBe(300000);
  });

  it('migrates legacy two-platform URLs into platformLinks without losing them', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/KXTEST',
      polymarketUrl: 'https://polymarket.com/event/test-market',
      eventTitle: 'Platform link migration', category: '', expiryDate: null,
    });

    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect((got as any).platformLinks).toEqual([
      { platform: 'kalshi', url: 'https://kalshi.com/markets/KXTEST' },
      { platform: 'polymarket', url: 'https://polymarket.com/event/test-market' },
    ]);
  });

  it('writes and reads back a fresh liveResult', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/x', polymarketUrl: 'https://polymarket.com/event/x',
      eventTitle: 'Test market', category: 'Politics', expiryDate: null,
    });
    await persistence.updateSavedMarketLiveResult(m.id, makeScan());
    const markets = await persistence.getSavedMarkets();
    const got = markets.find((x) => x.id === m.id)!;
    expect(got.liveResult).toBeTruthy();
    expect(got.liveResult!.bestRoiPct).toBe(5.5);
    expect(got.liveResult!.strategy).toBe('Buy YES Kalshi + NO PM');
    expect(got.liveResult!.allArbs).toHaveLength(1);
  });

  it('liveResult write does not touch lastScanResult', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/y', polymarketUrl: 'https://polymarket.com/event/y',
      eventTitle: 'Test 2', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketScanResult(m.id, makeScan({ bestRoiPct: 1.1 }));
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({ bestRoiPct: 9.9 }));
    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.lastScanResult!.bestRoiPct).toBe(1.1);
    expect(got.liveResult!.bestRoiPct).toBe(9.9);
  });

  it('stale liveResult (older than TTL) is dropped on read → poller fallback', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/z', polymarketUrl: 'https://polymarket.com/event/z',
      eventTitle: 'Test 3', category: '', expiryDate: null,
    });
    const staleTs = new Date(Date.now() - persistence.LIVE_RESULT_TTL_MS - 60_000).toISOString();
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({ scannedAt: staleTs }));
    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.liveResult).toBeNull();
  });

  it('liveResult with missing/garbage scannedAt is dropped', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/w', polymarketUrl: 'https://polymarket.com/event/w',
      eventTitle: 'Test 4', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({ scannedAt: 'not-a-date' }));
    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.liveResult).toBeNull();
  });

  it('clearSavedMarketLiveResult removes the live view', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/v', polymarketUrl: 'https://polymarket.com/event/v',
      eventTitle: 'Test 5', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketLiveResult(m.id, makeScan());
    // Seed the in-process saved-markets cache before the clear. The clear
    // must invalidate it just like every other saved-market write.
    expect((await persistence.getSavedMarkets()).find((x) => x.id === m.id)!.liveResult).toBeTruthy();
    await persistence.clearSavedMarketLiveResult(m.id);
    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.liveResult).toBeNull();
  });

  it('liveResult updates last_matched_at when matchedCount > 0', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/u', polymarketUrl: 'https://polymarket.com/event/u',
      eventTitle: 'Test 6', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({ matchedCount: 2 }));
    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.lastMatchedAt).toBeTruthy();
  });

  it('does not let an older completed scan overwrite a newer canonical match summary', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/order', polymarketUrl: 'https://polymarket.com/event/order',
      eventTitle: 'Ordering test', category: '', expiryDate: null,
    });
    const newer = makeScan({
      scannedAt: '2026-08-12T19:12:45.296Z', matchedCount: 2, matchStatus: 'matched',
    });
    const older = makeScan({
      scannedAt: '2026-08-12T19:11:45.296Z', matchedCount: 0,
      matchStatus: 'confirmed_zero', allArbs: [],
    });

    await persistence.updateSavedMarketScanResult(m.id, newer);
    await persistence.updateSavedMarketScanResult(m.id, older);

    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.lastScanResult).toMatchObject({
      scannedAt: newer.scannedAt, matchedCount: 2, matchStatus: 'matched',
    });
  });

  it('retains the latest confirmed matches when a temporary unavailable result arrives', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/failure', polymarketUrl: 'https://polymarket.com/event/failure',
      eventTitle: 'Failure retention', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketScanResult(m.id, makeScan({
      scannedAt: '2026-08-12T19:12:45.296Z', matchedCount: 2, matchStatus: 'matched',
    }));

    await persistence.updateSavedMarketScanResult(m.id, makeScan({
      scannedAt: '2026-08-12T19:13:45.296Z', matchedCount: 0,
      matchStatus: 'unavailable', matchError: 'Polymarket unavailable', allArbs: [],
    }));

    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.lastScanResult).toMatchObject({ matchedCount: 2, matchStatus: 'matched' });
  });
});
