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
  it('filters canonical scan-time TTE cumulatively before rows, metrics, counts, and exports', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-tte-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    for (const [marketId, daysToExpiry, bestProfit] of [
      ['tte-10', 10, 10],
      ['tte-45', 45, 45],
      ['tte-120', 120, 120],
      ['tte-200', 200, 200],
      ['tte-expired', -1, 999],
    ] as const) {
      const scannedAt = '2026-01-01T00:00:00.000Z';
      await persistence.saveScanResult(marketId, {
        bestRoiPct: daysToExpiry, bestProfit, strategy: 'Buy YES Kalshi + NO PM', outcomeCount: 1,
        matchedCount: 1, kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
        scannedAt,
        expiryAt: new Date(Date.parse(scannedAt) + daysToExpiry * 86_400_000).toISOString(),
      });
    }
    await persistence.saveScanResult('tte-unavailable', {
      bestRoiPct: 500, bestProfit: 500, strategy: 'Buy YES Kalshi + NO PM', outcomeCount: 1,
      matchedCount: 1, kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
      scannedAt: '2026-01-01T00:00:00.000Z',
    });

    const under90 = await persistence.queryScanHistory({ maxTteDays: 90, limit: 1 });
    expect(under90.rows.map((row) => row.market_id)).toEqual(['tte-45']);
    expect(under90.total).toBe(2);
    expect(under90.uniqueMarkets).toBe(2);
    expect(under90.summary.totalProfit).toBe(55);
    expect(under90.maxRoiWithoutMin).toBe(45);
    expect(await persistence.countScanHistory({ maxTteDays: 90 })).toBe(2);
    const streamed: string[] = [];
    for await (const batch of persistence.queryScanHistoryStream({ maxTteDays: 90, chunkSize: 1 })) {
      streamed.push(...batch.map((row) => row.market_id));
    }
    expect(streamed).toEqual(['tte-45', 'tte-10']);

    expect((await persistence.queryScanHistory({ maxTteDays: 30 })).rows.map((row) => row.market_id)).toEqual(['tte-10']);
    expect((await persistence.queryScanHistory({ maxTteDays: 180 })).rows.map((row) => row.market_id)).toEqual(['tte-120', 'tte-45', 'tte-10']);
    expect((await persistence.queryScanHistory({})).rows.map((row) => row.market_id)).toEqual([
      'tte-unavailable', 'tte-expired', 'tte-200', 'tte-120', 'tte-45', 'tte-10',
    ]);
  });

  it('reports the complete non-ROI-filtered maximum when min ROI excludes every row', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-roi-range-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    for (const [marketId, bestRoiPct] of [['low', 2.5], ['high', 8.75]] as const) {
      await persistence.saveScanResult(marketId, {
        bestRoiPct, bestProfit: 1, strategy: 'direct', outcomeCount: 1, matchedCount: 1,
        kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
        scannedAt: '2026-08-12T12:00:00.000Z', marketTitle: `${marketId} ROI market`,
      });
    }

    const result = await persistence.queryScanHistory({ minRoi: 99, positiveArbOnly: true });

    expect(result.rows).toHaveLength(0);
    expect(result.maxRoiWithoutMin).toBe(8.75);
  });

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
