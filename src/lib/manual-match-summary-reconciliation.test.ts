import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-133-manual-'));
const originalCwd = process.cwd();

let persistence: typeof import('./persistence');
let couplingStore: typeof import('./coupling-store');
let manualMatchRoute: typeof import('../app/api/manual-matches/route');
let manualMatchDeleteRoute: typeof import('../app/api/manual-matches/[id]/route');

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'data', 'manual-matches.json'), '[]');
  process.chdir(tmpDir);
  vi.resetModules();
  persistence = await import('./persistence');
  couplingStore = await import('./coupling-store');
  manualMatchRoute = await import('../app/api/manual-matches/route');
  manualMatchDeleteRoute = await import('../app/api/manual-matches/[id]/route');
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('BUG-133 manual coupling summary reconciliation', () => {
  it('updates the saved-market summary on create/delete and rejects an in-flight pre-delete result', async () => {
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/KXTX07',
      polymarketUrl: 'https://polymarket.com/event/tx-07',
      eventTitle: 'TX-07 House Election Winner',
      category: 'Politics',
      expiryDate: null,
    });
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: 0,
      bestProfit: 0,
      strategy: 'No arb',
      outcomeCount: 0,
      matchedCount: 0,
      matchStatus: 'confirmed_zero',
      matchedPairs: [],
      kalshiCount: 2,
      pmCount: 2,
      scannedAt: '2026-08-12T20:00:00.000Z',
      allArbs: [],
    });

    const createResponse = await manualMatchRoute.POST(new Request('http://localhost/api/manual-matches', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        marketId: market.id, kalshiTicker: 'TX07-D', pmConditionId: 'pm-d',
        kalshiTitle: 'Democratic', pmTitle: 'Democratic',
      }),
    }) as import('next/server').NextRequest);
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()).match as import('./manual-matches').ManualMatch;
    let saved = await persistence.getSavedMarketById(market.id);
    expect(saved?.lastScanResult).toMatchObject({
      matchedCount: 1,
      matchStatus: 'matched',
      matchedPairs: [{ artist: 'Democratic', kalshiTicker: 'TX07-D', pmConditionId: 'pm-d' }],
    });
    expect(saved?.lastScanResult?.matchDependencies).toEqual([expect.objectContaining({
      couplingKey: 'v1:kalshi:TX07-D|polymarket:pm-d', couplingRevision: 1,
      kalshiTicker: 'TX07-D', pmConditionId: 'pm-d',
    })]);

    const dependencies = await couplingStore.captureCouplingDependencies([
      { kalshiTicker: 'TX07-D', pmConditionId: 'pm-d' },
    ], 'test_inflight_scan');

    const deleteResponse = await manualMatchDeleteRoute.DELETE(
      new Request(`http://localhost/api/manual-matches/${created.id}`, { method: 'DELETE' }) as import('next/server').NextRequest,
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ success: true });
    saved = await persistence.getSavedMarketById(market.id);
    expect(saved?.lastScanResult).toMatchObject({
      matchedCount: 0,
      matchStatus: 'confirmed_zero',
      matchedPairs: [],
      matchDependencies: [],
    });

    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: 0,
      bestProfit: 0,
      strategy: 'No arb',
      outcomeCount: 1,
      matchedCount: 1,
      matchStatus: 'matched',
      matchedPairs: [{ artist: 'Democratic', kalshiTicker: 'TX07-D', pmConditionId: 'pm-d' }],
      matchDependencies: dependencies,
      kalshiCount: 2,
      pmCount: 2,
      scannedAt: '2026-08-12T20:05:00.000Z',
      allArbs: [],
    });
    saved = await persistence.getSavedMarketById(market.id);
    expect(saved?.lastScanResult).toMatchObject({ matchedCount: 0, matchedPairs: [] });
  });

  it('persists temporary unavailable state while retaining the last confirmed pair set', async () => {
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/KXFAIL',
      polymarketUrl: 'https://polymarket.com/event/fail',
      eventTitle: 'Temporary failure',
      category: 'Politics',
      expiryDate: null,
    });
    const dependencies = await couplingStore.captureCouplingDependencies([
      { kalshiTicker: 'FAIL-D', pmConditionId: 'fail-d' },
    ], 'test_failure');
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: 0, bestProfit: 0, strategy: 'No arb', outcomeCount: 1,
      matchedCount: 1, matchStatus: 'matched',
      matchedPairs: [{ artist: 'Democratic', kalshiTicker: 'FAIL-D', pmConditionId: 'fail-d' }],
      matchDependencies: dependencies,
      kalshiCount: 1, pmCount: 1, scannedAt: '2026-08-12T20:10:00.000Z', allArbs: [],
    });
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: 0, bestProfit: 0, strategy: 'No arb', outcomeCount: 0,
      matchedCount: 0, matchStatus: 'unavailable', matchError: 'Polymarket unavailable',
      matchedPairs: [], kalshiCount: 1, pmCount: 0,
      scannedAt: '2026-08-12T20:11:00.000Z', allArbs: [],
    });

    const saved = await persistence.getSavedMarketById(market.id);
    expect(saved?.lastScanResult).toMatchObject({
      matchedCount: 1,
      matchStatus: 'unavailable',
      matchError: 'Polymarket unavailable',
      matchedPairs: [{ kalshiTicker: 'FAIL-D', pmConditionId: 'fail-d' }],
    });
  });

  it('keeps the transactional manual record authoritative when the JSON mirror write fails', async () => {
    const mirror = path.join(tmpDir, 'data', 'manual-matches.json');
    fs.rmSync(mirror, { force: true });
    fs.mkdirSync(mirror);
    const manualMatches = await import('./manual-matches');

    const created = await manualMatches.addManualMatch({
      kalshiTicker: 'ATOMIC-D', pmConditionId: 'atomic-d',
      kalshiTitle: 'Atomic Democratic', pmTitle: 'Atomic Democratic',
    });

    expect(await manualMatches.getManualMatches()).toContainEqual(created);
  });
});
