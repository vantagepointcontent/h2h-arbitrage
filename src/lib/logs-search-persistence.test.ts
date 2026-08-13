import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tempDir = '';

afterEach(() => {
  delete process.env.H2H_SQLITE_PATH;
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Logs FTS persistence', () => {
  it('uses the FTS virtual-table index for case-insensitive contains search', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-search-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');

    await persistence.saveScanResult('outside-page', {
      bestRoiPct: 2,
      bestProfit: 1,
      strategy: 'Buy YES Kalshi + NO PM',
      outcomeCount: 1,
      matchedCount: 1,
      kalshiCount: 1,
      pmCount: 1,
      positiveArbCount: 1,
      totalStake: 100,
      scannedAt: '2026-08-12T12:00:00.000Z',
      marketTitle: 'MN-01 House Election Winner',
    });

    const result = await persistence.queryScanHistory({ search: 'mn-01', limit: 250 });
    expect(result.rows.map((row) => row.market_id)).toEqual(['outside-page']);
    const plan = await persistence.explainScanHistorySearchPlan('MN-01');
    expect(plan.join(' ')).toMatch(/VIRTUAL TABLE INDEX \d+:M\d+/i);
  });

  it('refreshes indexed fallback text when a saved market title changes', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-search-title-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    const suffix = crypto.randomUUID();
    const market = await persistence.addSavedMarket({
      kalshiUrl: `https://kalshi.com/markets/${suffix}`,
      polymarketUrl: `https://polymarket.com/event/${suffix}`,
      eventTitle: `Original fallback ${suffix}`, category: '', expiryDate: null,
    });
    await persistence.saveScanResult(market.id, {
      bestRoiPct: 2, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', outcomeCount: 1,
      matchedCount: 1, kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
      scannedAt: '2026-08-12T12:00:00.000Z',
    });

    await persistence.upsertSavedMarket({
      kalshiUrl: market.kalshiUrl, polymarketUrl: market.polymarketUrl,
      eventTitle: `MN-01 renamed ${suffix}`, category: '', expiryDate: null,
    });

    expect((await persistence.queryScanHistory({ search: 'mn-01' })).rows).toHaveLength(1);
    expect((await persistence.queryScanHistory({ search: `original fallback ${suffix}` })).rows).toHaveLength(0);

    await persistence.updateSavedMarket(market.id, { eventTitle: `Final searchable ${suffix}` });
    expect((await persistence.queryScanHistory({ search: `final searchable ${suffix}` })).rows).toHaveLength(1);
    expect((await persistence.queryScanHistory({ search: 'mn-01' })).rows).toHaveLength(0);
  });

  it.each([
    ['%', 'Literal % title'],
    ['_', 'Literal _ title'],
    ['\\', 'Literal \\ title'],
  ])('treats the short search term %s as a literal character', async (search, matchingTitle) => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-search-literal-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    await persistence.saveScanResult('matching', {
      bestRoiPct: 2, bestProfit: 1, strategy: 'direct', outcomeCount: 1, matchedCount: 1,
      kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
      scannedAt: '2026-08-12T12:00:00.000Z', marketTitle: matchingTitle,
    });
    await persistence.saveScanResult('ordinary', {
      bestRoiPct: 2, bestProfit: 1, strategy: 'direct', outcomeCount: 1, matchedCount: 1,
      kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
      scannedAt: '2026-08-12T11:00:00.000Z', marketTitle: 'Ordinary title',
    });

    const result = await persistence.queryScanHistory({ search });
    expect(result.rows.map((row) => row.market_id)).toEqual(['matching']);
    expect(result.total).toBe(1);
  });
});
