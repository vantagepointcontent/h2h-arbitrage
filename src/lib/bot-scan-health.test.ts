import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalCwd: string;
let tempDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-scan-health-'));
  fs.mkdirSync(path.join(tempDir, 'data'));
  process.chdir(tempDir);
  vi.resetModules();

  const db = createClient({ url: `file:${path.join(tempDir, 'data', 'edgefinder.db')}` });
  await db.execute(`CREATE TABLE scan_results (
    id INTEGER PRIMARY KEY,
    market_id TEXT NOT NULL,
    market_title TEXT,
    scanned_at TEXT NOT NULL,
    positive_arb_count INTEGER NOT NULL DEFAULT 0,
    raw_result TEXT
  )`);
  await db.batch([
    { sql: 'INSERT INTO scan_results VALUES (?,?,?,?,?,?)', args: [41, 'm-41', 'Terminal', '2026-08-16T17:00:00.000Z', 0, '{}'] },
    { sql: 'INSERT INTO scan_results VALUES (?,?,?,?,?,?)', args: [42, 'm-42', 'In progress', '2026-08-16T17:01:00.000Z', 1, '{}'] },
  ], 'write');
  db.close();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('getBotScanHealth terminal decision semantics', () => {
  it('keeps lastExecutionOrSkip terminal while exposing the newest lease separately', async () => {
    const { getBotScanHealth } = await import('./bot-scan-consumer');
    await getBotScanHealth();
    const db = createClient({ url: `file:${path.join(tempDir, 'data', 'edgefinder.db')}` });
    await db.batch([
      {
        sql: `INSERT INTO bot_scan_decisions
          (scan_id,idempotency_key,source,state,reason_code,reason,received_at,updated_at)
          VALUES (41,'scan:41','catch_up','criteria_rejected','no_opportunities','No opportunities','2026-08-16T17:00:01.000Z','2026-08-16T17:00:02.000Z')`,
        args: [],
      },
      {
        sql: `INSERT INTO bot_scan_decisions
          (scan_id,idempotency_key,source,state,reason_code,reason,received_at,updated_at,lease_owner,lease_expires_at)
          VALUES (42,'scan:42','catch_up','received','scan_received','Persisted completed scan received','2026-08-16T17:01:01.000Z','2026-08-16T17:01:01.000Z','lease-42','2026-08-16T17:16:01.000Z')`,
        args: [],
      },
      {
        sql: `INSERT INTO bot_opportunity_decisions
          (scan_id,candidate_index,market_id,outcome,strategy,state,reason_code,reason,roi_pct,apy_pct,created_at,updated_at,details)
          VALUES (41,0,'pair-1','A','Buy YES Kalshi + NO PM','eligible','scan_eligible','Authoritative fees available',5,25,'2026-08-16T17:00:01.000Z','2026-08-16T17:00:01.000Z','{"inputs":{"fees":{"kalshiFee":0.01,"pmFee":0.02}}}')`,
        args: [],
      },
    ], 'write');
    db.close();

    await expect(getBotScanHealth()).resolves.toMatchObject({
      latestDecisionScanId: 42,
      opportunitiesEvaluated: 1,
      eligibleCount: 1,
      lastExecutionOrSkip: { scanId: 41, state: 'criteria_rejected', reason: 'No opportunities' },
      inProgress: { scanId: 42, state: 'received' },
    });
  });
});