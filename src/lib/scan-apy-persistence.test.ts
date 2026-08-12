import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const prefix = `test-scan-apy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-apy-'));
const dbPath = path.join(tempDir, 'edgefinder.db');
const db = createClient({ url: `file:${dbPath}` });
let persistence: typeof import('./persistence');

beforeAll(async () => {
  await db.execute(`CREATE TABLE scan_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT NOT NULL,
    best_roi_pct REAL NOT NULL DEFAULT 0, best_profit REAL NOT NULL DEFAULT 0,
    strategy TEXT NOT NULL DEFAULT '', outcome_count INTEGER NOT NULL DEFAULT 0,
    matched_count INTEGER NOT NULL DEFAULT 0, kalshi_count INTEGER NOT NULL DEFAULT 0,
    pm_count INTEGER NOT NULL DEFAULT 0, positive_arb_count INTEGER NOT NULL DEFAULT 0,
    total_stake REAL NOT NULL DEFAULT 0, scanned_at TEXT NOT NULL, raw_result TEXT,
    market_title TEXT, kalshi_url TEXT, polymarket_url TEXT, arb_type TEXT
  )`);
  await db.execute({
    sql: `INSERT INTO scan_results
      (market_id, best_roi_pct, best_profit, strategy, positive_arb_count, scanned_at, raw_result)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [`${prefix}-legacy-valid`, 2.5, 12.5, 'Buy YES Kalshi + NO PM', 1, '2026-08-12T12:00:00.000Z', JSON.stringify({ expiryDate: '2026-08-13T00:00:00.000Z' })],
  });
  await db.execute({
    sql: `INSERT INTO scan_results
      (market_id, best_roi_pct, scanned_at, raw_result)
      VALUES (?, ?, ?, ?)`,
    args: [`${prefix}-legacy-missing`, 4, '2026-08-12T12:00:00.000Z', null],
  });

  process.env.H2H_SQLITE_PATH = dbPath;
  vi.resetModules();
  persistence = await import('./persistence');
});

afterAll(async () => {
  db.close();
  delete process.env.H2H_SQLITE_PATH;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('scan-time APY persistence', () => {
  it('backfills eligible historical rows and records explicit unavailable reasons', async () => {
    const { rows } = await persistence.queryScanHistory({ limit: 500 });
    const valid = rows.find((row) => row.market_id === `${prefix}-legacy-valid`);
    const missing = rows.find((row) => row.market_id === `${prefix}-legacy-missing`);

    expect(valid.apy_pct).toBeCloseTo(1825, 8);
    expect(valid.days_to_expiry).toBe(0.5);
    expect(valid.expiry_at).toBe('2026-08-13T00:00:00.000Z');
    expect(valid.apy_unavailable_reason).toBeNull();
    expect(missing.apy_pct).toBeNull();
    expect(missing.apy_unavailable_reason).toBe('missing_expiry');
  });

  it('persists a stable snapshot from exact scan and expiry timestamps', async () => {
    const saved = await persistence.saveScanResult(`${prefix}-new-valid`, {
      bestRoiPct: 3,
      bestProfit: 10,
      strategy: 'Buy YES Kalshi + NO PM',
      outcomeCount: 1,
      matchedCount: 1,
      kalshiCount: 1,
      pmCount: 1,
      positiveArbCount: 1,
      scannedAt: '2026-08-12T12:00:00.000Z',
      expiryAt: '2026-08-14T00:00:00.000Z',
    });

    const first = (await persistence.queryScanHistory({ limit: 500 })).rows.find((row) => row.id === saved.id);
    expect(first.apy_pct).toBeCloseTo(730, 8);
    expect(first.days_to_expiry).toBe(1.5);

    const second = (await persistence.queryScanHistory({ limit: 500 })).rows.find((row) => row.id === saved.id);
    expect(second.apy_pct).toBe(first.apy_pct);
    expect(second.days_to_expiry).toBe(first.days_to_expiry);
  });
});
