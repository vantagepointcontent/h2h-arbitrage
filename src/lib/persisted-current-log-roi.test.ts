import { createClient } from '@libsql/client';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let tempDir: string | null = null;

afterEach(() => {
  vi.resetModules();
  delete process.env.H2H_SQLITE_PATH;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function scan(overrides: Record<string, unknown> = {}) {
  return {
    bestRoiPct: 2,
    bestProfit: 2,
    strategy: 'Buy YES Kalshi + NO PM',
    arbType: 'direct' as const,
    outcomeCount: 1,
    matchedCount: 1,
    kalshiCount: 1,
    pmCount: 1,
    positiveArbCount: 1,
    totalStake: 100,
    scannedAt: '2026-08-13T20:00:00.000Z',
    marketTitle: 'Same displayed title',
    kalshiUrl: 'https://kalshi.com/markets/exact/event/EXACT',
    polymarketUrl: 'https://polymarket.com/event/exact',
    ...overrides,
  };
}

describe('getLatestCompletedScanRoiForLogIds', () => {
  it('resolves duplicate rows from the newest completed exact URL pair without title leakage', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persisted-current-roi-'));
    const dbPath = path.join(tempDir, 'logs.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    const persistence = await import('./persistence');

    const first = await persistence.saveScanResult('market-a-old', scan({ scannedAt: '2026-08-13T20:00:00.000Z', bestRoiPct: 1.1 }));
    const duplicate = await persistence.saveScanResult('market-a-duplicate', scan({ scannedAt: '2026-08-13T20:01:00.000Z', bestRoiPct: 2.2 }));
    const latest = await persistence.saveScanResult('market-a-latest', scan({ scannedAt: '2026-08-13T20:03:00.000Z', bestRoiPct: 4.4 }));
    const failed = await persistence.saveScanResult('market-a-failed', scan({ scannedAt: '2026-08-13T20:04:00.000Z', bestRoiPct: 99 }));
    const incomplete = await persistence.saveScanResult('market-a-incomplete', scan({ scannedAt: '2026-08-13T20:05:00.000Z', bestRoiPct: 88 }));
    await persistence.saveScanResult('market-a-stale-insert', scan({ scannedAt: '2026-08-13T20:02:00.000Z', bestRoiPct: 3.3 }));

    const similar = await persistence.saveScanResult('market-similar-title', scan({
      scannedAt: '2026-08-13T20:06:00.000Z',
      bestRoiPct: 8.8,
      kalshiUrl: 'https://kalshi.com/markets/similar/event/SIMILAR',
      polymarketUrl: 'https://polymarket.com/event/similar',
    }));
    const onlyFailed = await persistence.saveScanResult('market-only-failed', scan({
      scannedAt: '2026-08-13T20:06:30.000Z',
      bestRoiPct: 77,
      kalshiUrl: 'https://kalshi.com/markets/only-failed/event/FAILED',
      polymarketUrl: 'https://polymarket.com/event/only-failed',
    }));
    const noArb = await persistence.saveScanResult('market-no-arb', scan({
      scannedAt: '2026-08-13T20:07:00.000Z',
      bestRoiPct: 0,
      bestProfit: 0,
      strategy: 'No arb',
      arbType: undefined,
      positiveArbCount: 0,
      kalshiUrl: 'https://kalshi.com/markets/no-arb/event/NOARB',
      polymarketUrl: 'https://polymarket.com/event/no-arb',
    }));
    const invalid = await persistence.saveScanResult('market-invalid', scan({
      scannedAt: '2026-08-13T20:07:30.000Z',
      strategy: 'Same-platform YES+YES Kalshi: A + B',
      arbType: 'internal',
      kalshiUrl: 'https://kalshi.com/markets/invalid/event/INVALID',
      polymarketUrl: 'https://polymarket.com/event/invalid',
    }));
    const missingLinks = await persistence.saveScanResult('market-missing-links', scan({
      scannedAt: '2026-08-13T20:08:00.000Z',
      kalshiUrl: undefined,
      polymarketUrl: undefined,
    }));

    const db = createClient({ url: `file:${dbPath}` });
    await db.execute({ sql: 'UPDATE scan_results SET scan_status = ? WHERE id = ?', args: ['failed', failed.id] });
    await db.execute({ sql: 'UPDATE scan_results SET scan_status = ? WHERE id = ?', args: ['incomplete', incomplete.id] });
    await db.execute({ sql: 'UPDATE scan_results SET scan_status = ? WHERE id = ?', args: ['failed', onlyFailed.id] });
    db.close();

    await expect(persistence.getLatestCompletedScanRoiForLogIds([
      first.id,
      duplicate.id,
      similar.id,
      onlyFailed.id,
      noArb.id,
      invalid.id,
      missingLinks.id,
      999_999,
      first.id,
    ])).resolves.toEqual([
      { id: first.id, status: 'available', roiPct: 4.4, strategy: 'Buy YES Kalshi + NO PM', scannedAt: '2026-08-13T20:03:00.000Z', scanId: latest.id },
      { id: duplicate.id, status: 'available', roiPct: 4.4, strategy: 'Buy YES Kalshi + NO PM', scannedAt: '2026-08-13T20:03:00.000Z', scanId: latest.id },
      { id: similar.id, status: 'available', roiPct: 8.8, strategy: 'Buy YES Kalshi + NO PM', scannedAt: '2026-08-13T20:06:00.000Z', scanId: similar.id },
      { id: onlyFailed.id, status: 'unavailable' },
      { id: noArb.id, status: 'no_arbitrage', scannedAt: '2026-08-13T20:07:00.000Z', scanId: noArb.id },
      { id: invalid.id, status: 'unavailable' },
      { id: missingLinks.id, status: 'unavailable' },
      { id: 999_999, status: 'never_scanned' },
    ]);
  });
});
