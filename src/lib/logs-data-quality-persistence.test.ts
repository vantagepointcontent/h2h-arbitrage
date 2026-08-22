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
  it('does not publish a non-executable zero profit as an available financial value', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-quality-non-executable-'));
    const dbPath = path.join(tempDir, 'logs.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    const persistence = await import('./persistence');

    const saved = await persistence.saveScanResult('indicative-only', scan({
      bestProfit: 0,
      totalStake: 0,
      positiveArbCount: 0,
      raw: { allArbs: [{
        roiPct: 2.5,
        expectedProfit: 0,
        totalStake: 0,
        strategy: 'Buy YES Kalshi + NO PM',
        executionStatus: 'non_executable',
        executionBlocker: 'Kalshi executable quote unavailable',
      }] },
    }));

    const history = await persistence.queryScanHistory({ limit: 1 });
    const { resolveHistoricalScanFinancials } = await import('./historical-scan-financials');
    expect(resolveHistoricalScanFinancials(history.rows[0]).fields.profitUsd).toMatchObject({
      status: 'unavailable',
      reasonCode: 'current_candidate_non_executable',
    });
    const db = createClient({ url: `file:${dbPath}` });
    const snapshot = JSON.parse(String((await db.execute({
      sql: 'SELECT snapshot_json FROM logs_data_quality_batches WHERE scan_id = ?', args: [saved.id],
    })).rows[0].snapshot_json));
    expect(snapshot.fields.profit).toMatchObject({
      denominator: 1,
      available: 0,
      unavailable: 1,
      reasons: { current_candidate_non_executable: 1 },
    });
    expect(snapshot.breaches).not.toContainEqual(expect.objectContaining({
      field: 'profit', trigger: 'all_zero_population',
    }));
    db.close();
  });

  it('persists every completed batch and emits a durable alert on an immediate breach', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-quality-'));
    const dbPath = path.join(tempDir, 'logs.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    const persistence = await import('./persistence');

    const healthy = await persistence.saveScanResult('healthy', scan());
    const degraded = await persistence.saveScanResult('degraded', scan({
      bestProfit: undefined,
      totalStake: undefined,
      raw: { allArbs: [{ roiPct: 2.5, strategy: 'Buy YES Kalshi + NO PM' }] },
      scannedAt: '2026-08-20T10:01:00.000Z',
    }) as Parameters<typeof persistence.saveScanResult>[1]);

    const db = createClient({ url: `file:${dbPath}` });
    const batches = await db.execute('SELECT scan_id, state, reconciliation_attempts, snapshot_json FROM logs_data_quality_batches ORDER BY scan_id');
    expect(batches.rows).toHaveLength(2);
    expect((await db.execute('SELECT COUNT(*) AS count FROM scan_results')).rows[0].count).toBe(2);
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

  it('backfills recent telemetry without changing the canonical scan row count', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-quality-backfill-'));
    const dbPath = path.join(tempDir, 'logs.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    let persistence = await import('./persistence');
    for (let index = 0; index < 12; index += 1) {
      await persistence.saveScanResult(`backfill-${index}`, scan({
        scannedAt: new Date(Date.parse('2026-08-20T10:00:00.000Z') + index * 60_000).toISOString(),
      }));
    }

    const db = createClient({ url: `file:${dbPath}` });
    const before = Number((await db.execute('SELECT COUNT(*) AS count FROM scan_results')).rows[0].count);
    await db.execute('DELETE FROM logs_data_quality_batches');
    expect((await db.execute('SELECT COUNT(*) AS count FROM logs_data_quality_batches')).rows[0].count).toBe(0);

    vi.resetModules();
    persistence = await import('./persistence');
    await persistence.queryScanHistory({ limit: 1 });

    const after = Number((await db.execute('SELECT COUNT(*) AS count FROM scan_results')).rows[0].count);
    const telemetryRows = Number((await db.execute('SELECT COUNT(*) AS count FROM logs_data_quality_batches')).rows[0].count);
    expect(after).toBe(before);
    expect(after).toBe(12);
    expect(telemetryRows).toBe(12);
    db.close();
  });
});
