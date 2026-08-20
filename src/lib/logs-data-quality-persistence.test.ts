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
    bestRoiPct: 2.5,
    bestProfit: 5,
    strategy: 'Buy YES Kalshi + NO PM',
    arbType: 'direct' as const,
    outcomeCount: 1,
    matchedCount: 1,
    kalshiCount: 1,
    pmCount: 1,
    positiveArbCount: 1,
    totalStake: 200,
    scannedAt: '2026-08-20T10:00:00.000Z',
    expiryAt: '2026-09-20T10:00:00.000Z',
    kalshiUrl: 'https://kalshi.com/markets/exact/event/EXACT',
    polymarketUrl: 'https://polymarket.com/event/exact',
    raw: { allArbs: [{ roiPct: 2.5, expectedProfit: 5, totalStake: 200, strategy: 'Buy YES Kalshi + NO PM' }] },
    ...overrides,
  };
}

describe('Logs data-quality persistence guardrail', () => {
  it('persists every completed batch and emits a durable alert on an immediate breach', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-quality-'));
    const dbPath = path.join(tempDir, 'logs.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    const persistence = await import('./persistence');

    const healthy = await persistence.saveScanResult('healthy', scan());
    const degraded = await persistence.saveScanResult('degraded', scan({
      bestProfit: 0,
      totalStake: 0,
      raw: { allArbs: [{ roiPct: 2.5, strategy: 'Buy YES Kalshi + NO PM' }] },
      scannedAt: '2026-08-20T10:01:00.000Z',
    }));

    const db = createClient({ url: `file:${dbPath}` });
    const batches = await db.execute('SELECT scan_id, state, reconciliation_attempts, snapshot_json FROM logs_data_quality_batches ORDER BY scan_id');
    expect(batches.rows).toHaveLength(2);
    expect(batches.rows[0]).toMatchObject({ scan_id: healthy.id, state: 'healthy', reconciliation_attempts: 0 });
    expect(batches.rows[1]).toMatchObject({ scan_id: degraded.id, state: 'degraded', reconciliation_attempts: 2 });
    expect(JSON.parse(String(batches.rows[1].snapshot_json))).toMatchObject({
      breaches: expect.arrayContaining([expect.objectContaining({ field: 'profit', trigger: 'structural_zero_tolerance' })]),
      reconciliation: { requested: true, maxAttempts: 2 },
    });
    const alerts = await db.execute('SELECT scan_id, reason FROM logs_data_quality_alerts');
    expect(alerts.rows).toEqual([expect.objectContaining({ scan_id: degraded.id, reason: expect.stringContaining('profit:structural_zero_tolerance') })]);
    db.close();
  });
});
