import { createClient } from '@libsql/client';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverHistoricalScanFinancials } from './historical-scan-financial-recovery';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('recoverHistoricalScanFinancials', () => {
  it('dry-runs and applies authoritative raw snapshots with revision fencing idempotently', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-financial-recovery-'));
    const client = createClient({ url: `file:${path.join(tempDir, 'recovery.db')}` });
    await client.execute(`CREATE TABLE scan_results (
      id INTEGER PRIMARY KEY,
      positive_arb_count INTEGER NOT NULL,
      best_roi_pct REAL,
      best_profit REAL,
      apy_pct REAL,
      total_stake REAL,
      raw_result TEXT,
      calculation_envelope TEXT
    )`);
    await client.batch([
      {
        sql: `INSERT INTO scan_results VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [1, 1, 2.5, 5, 100, 200, null, null],
      },
      {
        sql: `INSERT INTO scan_results VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [2, 1, 0, 0, null, 0, JSON.stringify({ allArbs: [{ roiPct: 1.25, expectedProfit: 2.5, apyPct: 30, totalStake: 200 }] }), null],
      },
      {
        sql: `INSERT INTO scan_results VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [3, 1, 3, null, null, 100, JSON.stringify({ allArbs: [{ expectedProfit: 4 }] }), null],
      },
    ]);

    const dryRun = await recoverHistoricalScanFinancials(client, { apply: false });
    expect(dryRun.counts).toMatchObject({
      inspected: 3,
      recovered: 3,
      fullyRecoverable: 2,
      partiallyRecoverable: 1,
      unrecoverable: 0,
      conflicted: 0,
      applied: 0,
    });
    expect((await client.execute('PRAGMA table_info(scan_results)')).rows.some((row) => row.name === 'historical_financials_revision')).toBe(false);

    const applied = await recoverHistoricalScanFinancials(client, { apply: true });
    expect(applied.counts.applied).toBe(3);
    expect((await client.execute('SELECT COUNT(*) AS count FROM scan_results')).rows[0].count).toBe(3);
    const recovered = await client.execute('SELECT * FROM scan_results WHERE id = 2');
    expect(recovered.rows[0]).toMatchObject({
      best_roi_pct: 1.25,
      best_profit: 2.5,
      apy_pct: 30,
      total_stake: 200,
      historical_financials_revision: 3,
    });

    const second = await recoverHistoricalScanFinancials(client, { apply: true });
    expect(second.counts).toMatchObject({ inspected: 0, applied: 0, conflicted: 0, alreadyCurrent: 3 });
    expect((await client.execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe('ok');
    client.close();
  });

  it('refuses a stale recovery when authoritative source evidence changes after audit', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-financial-recovery-race-'));
    const dbPath = path.join(tempDir, 'recovery.db');
    const client = createClient({ url: `file:${dbPath}` });
    const concurrent = createClient({ url: `file:${dbPath}` });
    await client.execute(`CREATE TABLE scan_results (
      id INTEGER PRIMARY KEY,
      positive_arb_count INTEGER NOT NULL,
      best_roi_pct REAL,
      best_profit REAL,
      apy_pct REAL,
      total_stake REAL,
      raw_result TEXT,
      calculation_envelope TEXT
    )`);
    const originalRaw = JSON.stringify({ allArbs: [{ roiPct: 1.25, expectedProfit: 2.5, apyPct: 30, totalStake: 200 }] });
    const correctedRaw = JSON.stringify({ allArbs: [{ roiPct: 9.5, expectedProfit: 19, apyPct: 90, totalStake: 200 }] });
    await client.execute({
      sql: 'INSERT INTO scan_results VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [1, 1, 0, 0, null, 0, originalRaw, null],
    });

    const originalBatch = client.batch.bind(client);
    client.batch = (async (statements, mode) => {
      await concurrent.execute({
        sql: 'UPDATE scan_results SET raw_result = ? WHERE id = 1',
        args: [correctedRaw],
      });
      return originalBatch(statements, mode);
    }) as typeof client.batch;

    const report = await recoverHistoricalScanFinancials(client, { apply: true });
    expect(report.counts).toMatchObject({ inspected: 1, applied: 0, conflicted: 1 });
    const row = (await concurrent.execute('SELECT * FROM scan_results WHERE id = 1')).rows[0];
    expect(row).toMatchObject({
      best_roi_pct: 0,
      best_profit: 0,
      total_stake: 0,
      raw_result: correctedRaw,
      historical_financials_revision: null,
      historical_financials_provenance: null,
    });
    concurrent.close();
    client.close();
  });

  it('recovers and enumerates the selected-candidate cohort even when executable count is zero', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-financial-selected-candidate-'));
    const client = createClient({ url: `file:${path.join(tempDir, 'recovery.db')}` });
    await client.execute(`CREATE TABLE scan_results (
      id INTEGER PRIMARY KEY, strategy TEXT NOT NULL, positive_arb_count INTEGER NOT NULL,
      best_roi_pct REAL, best_profit REAL, apy_pct REAL, total_stake REAL,
      raw_result TEXT, calculation_envelope TEXT
    )`);
    await client.batch([
      { sql: 'INSERT INTO scan_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [
        1, 'Buy YES Kalshi + NO PM', 0, 0, 0, 0, 0,
        JSON.stringify({ allArbs: [{ strategy: 'Buy YES Kalshi + NO PM', roiPct: 2, expectedProfit: 2, apyPct: 20, totalStake: 100 }] }), null,
      ] },
      { sql: 'INSERT INTO scan_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [
        2, 'Buy YES Kalshi + NO PM', 0, 0, 0, 0, 0, null, null,
      ] },
      { sql: 'INSERT INTO scan_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [
        3, 'No arb', 0, 0, 0, 0, 0, null, null,
      ] },
    ], 'write');

    const report = await recoverHistoricalScanFinancials(client, { apply: true });
    expect(report.counts).toMatchObject({ inspected: 2, recovered: 1, unrecoverable: 1, applied: 2 });
    expect(report.unrecoverableReasons).toEqual({ historical_financials_not_persisted: 1 });
    expect((await client.execute('SELECT best_roi_pct FROM scan_results WHERE id = 1')).rows[0].best_roi_pct).toBe(2);
    client.close();
  });
});
