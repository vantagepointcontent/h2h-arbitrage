import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const dbPath = path.join(os.tmpdir(), `h2h-closed-position-migration-${process.pid}-${Date.now()}.db`);
const originalPath = process.env.H2H_SQLITE_PATH;

afterAll(async () => {
  if (originalPath == null) delete process.env.H2H_SQLITE_PATH;
  else process.env.H2H_SQLITE_PATH = originalPath;
  await fs.rm(dbPath, { force: true });
  await fs.rm(`${dbPath}-shm`, { force: true });
  await fs.rm(`${dbPath}-wal`, { force: true });
});

describe('closed_positions nullable migration', () => {
  it('migrates a pre-nullable table idempotently and preserves SQLite integrity', async () => {
    const setup = createClient({ url: `file:${dbPath}` });
    await setup.execute(`CREATE TABLE closed_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market_title TEXT NOT NULL, platform TEXT NOT NULL,
      side TEXT NOT NULL, size REAL NOT NULL, entry_price REAL NOT NULL DEFAULT 0,
      exit_price REAL NOT NULL, realized_pnl REAL NOT NULL, roi_pct REAL NOT NULL,
      opened_at TEXT, closed_at TEXT NOT NULL, duration_secs INTEGER, pair_id TEXT,
      fees_paid REAL NOT NULL, ticker TEXT, condition_id TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'live', raw_data TEXT
    )`);
    await setup.execute({
      sql: `INSERT INTO closed_positions
        (market_title, platform, side, size, entry_price, exit_price, realized_pnl, roi_pct, closed_at, fees_paid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['Legacy migration fixture', 'kalshi', 'YES', 2, 0.4, 0.6, 0.35, 43.75, '2026-08-14T12:00:00.000Z', 0.05],
    });
    setup.close();

    process.env.H2H_SQLITE_PATH = dbPath;
    vi.resetModules();
    const { getClosedPositions } = await import('./persistence');

    const first = await getClosedPositions(10);
    const second = await getClosedPositions(10);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      marketTitle: 'Legacy migration fixture',
      size: 2,
      exitPrice: 0.6,
      realizedPnl: 0.35,
      roiPct: 43.75,
      feesPaid: 0.05,
      calculationEnvelope: { status: 'legacy_unverifiable' },
    });

    const verify = createClient({ url: `file:${dbPath}` });
    const columns = await verify.execute('PRAGMA table_info(closed_positions)');
    const nullable = new Set(['size', 'exit_price', 'realized_pnl', 'roi_pct', 'fees_paid']);
    expect(columns.rows.filter((row) => nullable.has(String(row.name))).every((row) => Number(row.notnull) === 0)).toBe(true);
    expect((await verify.execute('PRAGMA integrity_check')).rows[0]?.integrity_check).toBe('ok');
    verify.close();
  });
});
