import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-retention-'));
const originalCwd = process.cwd();
let persistence: typeof import('./persistence');

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  process.chdir(tmpDir);
  vi.resetModules();
  persistence = await import('./persistence');
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function scan(scannedAt: string, positiveArbCount: number) {
  return {
    bestRoiPct: positiveArbCount > 0 ? 2 : 0,
    bestProfit: positiveArbCount > 0 ? 2 : 0,
    strategy: positiveArbCount > 0 ? 'Buy YES Kalshi + NO PM' : 'No arb',
    outcomeCount: 2,
    matchedCount: 1,
    kalshiCount: 1,
    pmCount: 1,
    positiveArbCount,
    scannedAt,
  };
}

describe('scan retention policy', () => {
  it('deletes only zero-arbitrage scans older than seven days', async () => {
    const old = '2020-01-01T00:00:00.000Z';
    const recent = new Date().toISOString();
    await persistence.saveScanResult('old-positive', scan(old, 1));
    await persistence.saveScanResult('old-zero', scan(old, 0));
    await persistence.saveScanResult('recent-zero', scan(recent, 0));

    expect(await persistence.pruneOldScans(7)).toBe(1);
    expect(await persistence.getScanCount()).toBe(2);
    expect((await persistence.getScanHistory('old-positive', 10))).toHaveLength(1);
    expect((await persistence.getScanHistory('old-zero', 10))).toHaveLength(0);
  });
});
