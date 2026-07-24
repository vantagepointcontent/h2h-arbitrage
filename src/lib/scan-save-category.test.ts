import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-cat-'));
const origCwd = process.cwd();

let persistence: typeof import('@/lib/persistence');
let classify: typeof import('@/lib/market-classification');

describe('scan save category flow', () => {
  beforeAll(async () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    process.chdir(tmpDir);
    vi.resetModules();
    persistence = await import('@/lib/persistence');
    classify = await import('@/lib/market-classification');
  });

  afterAll(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifyMarket returns domain from title keywords', () => {
    expect(classify.classifyMarket('Will Arsenal win the Premier League?').domain).toBe('sports');
    expect(classify.classifyMarket('Who will win the 2024 US election?').domain).toBe('politics');
    expect(classify.classifyMarket('Will BTC hit $100k by year end?').domain).toBe('crypto');
  });

  it('addSavedMarket persists category when provided', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/KXSPORT',
      polymarketUrl: 'https://polymarket.com/event/arsenal-title',
      eventTitle: 'Arsenal vs Chelsea',
      category: 'sports',
      expiryDate: null,
    });
    expect(m.category).toBe('sports');
    const rows = await persistence.getSavedMarkets();
    const got = rows.find((r) => r.id === m.id)!;
    expect(got.category).toBe('sports');
  });

  it('addSavedMarket defaults empty category to empty string', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/KXDEF',
      polymarketUrl: 'https://polymarket.com/event/default-cat',
      eventTitle: 'Default category market',
      category: '',
      expiryDate: null,
    });
    expect(m.category).toBe('');
  });

  it('updateSavedMarketScanResult stores category inside last_scan_result JSON', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/KXCAT2',
      polymarketUrl: 'https://polymarket.com/event/cat-test',
      eventTitle: 'Category scan result test',
      category: 'politics',
      expiryDate: null,
    });

    const scanResult: persistence.LastScanResult = {
      bestRoiPct: 3.3,
      bestProfit: 33,
      strategy: 'Buy YES Kalshi + NO PM',
      outcomeCount: 2,
      matchedCount: 2,
      kalshiCount: 2,
      pmCount: 2,
      scannedAt: new Date().toISOString(),
      category: 'politics',
      allArbs: [],
    };

    await persistence.updateSavedMarketScanResult(m.id, scanResult);
    const rows = await persistence.getSavedMarkets();
    const got = rows.find((r) => r.id === m.id)!;
    expect(got.lastScanResult?.category).toBe('politics');
  });
});
