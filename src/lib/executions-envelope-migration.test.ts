import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateExecutionsSchema } from './persistence';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('existing executions calculation-envelope migration', () => {
  it('adds and backfills the column before UPDATE and remains idempotent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ops185-executions-'));
    tempDirs.push(dir);
    const client = createClient({ url: `file:${path.join(dir, 'legacy.db')}` });

    await client.execute(`
      CREATE TABLE executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        arb_id TEXT NOT NULL,
        market_title TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 1,
        success INTEGER NOT NULL DEFAULT 0,
        strategy TEXT,
        kalshi_order TEXT,
        polymarket_order TEXT,
        result TEXT,
        estimated_profit REAL NOT NULL DEFAULT 0
      )
    `);
    await client.execute({
      sql: `INSERT INTO executions
        (timestamp, arb_id, market_title, estimated_profit)
        VALUES (?, ?, ?, ?)`,
      args: ['2026-08-17T00:00:00.000Z', 'legacy-arb', 'Legacy execution', 12.34],
    });

    await migrateExecutionsSchema(client);
    const first = await client.execute('SELECT * FROM executions WHERE arb_id = \'legacy-arb\'');
    const firstEnvelope = JSON.parse(String(first.rows[0].calculation_envelope));
    expect(firstEnvelope).toMatchObject({
      version: 1,
      scope: 'execution',
      status: 'legacy_unverifiable',
      totals: { totalFeesMicros: null, netPnlMicros: null },
    });
    expect(first.rows[0].estimated_profit).toBe(12.34);
    expect(first.rows[0].source).toBe('unknown');

    await migrateExecutionsSchema(client);
    const second = await client.execute('SELECT * FROM executions WHERE arb_id = \'legacy-arb\'');
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].calculation_envelope).toBe(first.rows[0].calculation_envelope);

    const columns = await client.execute('PRAGMA table_info(executions)');
    expect(columns.rows.filter((row) => row.name === 'calculation_envelope')).toHaveLength(1);
    expect(columns.rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      'paper_position_deleted_at',
      'paper_position_deletion_reason',
      'paper_position_deletion_source_revision',
      'source',
    ]));
    expect((await client.execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe('ok');
    expect((await client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
    client.close();
  });
});
