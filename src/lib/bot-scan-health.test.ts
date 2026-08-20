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
    raw_result TEXT,
    scan_status TEXT NOT NULL DEFAULT 'completed'
  )`);
  await db.batch([
    { sql: 'INSERT INTO scan_results VALUES (?,?,?,?,?,?,?)', args: [41, 'm-41', 'Terminal', '2026-08-16T17:00:00.000Z', 0, '{}', 'completed'] },
    { sql: 'INSERT INTO scan_results VALUES (?,?,?,?,?,?,?)', args: [42, 'm-42', 'In progress', '2026-08-16T17:01:00.000Z', 1, '{}', 'completed'] },
    { sql: 'INSERT INTO scan_results VALUES (?,?,?,?,?,?,?)', args: [43, 'm-43', 'Incomplete publication', '2026-08-16T17:02:00.000Z', 9, '{}', 'incomplete'] },
  ], 'write');
  db.close();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('getBotScanHealth terminal decision semantics', () => {
  it('does not count canonical non-positive scans as pending BotTrader work', async () => {
    const { getBotScanEvaluationSummaries, getBotScanHealth } = await import('./bot-scan-consumer');

    await expect(getBotScanHealth()).resolves.toMatchObject({
      latestCompletedScanId: 42,
      latestPositiveScanId: 42,
      pendingScans: 1,
      cursorLag: 1,
      opportunitiesEvaluated: 0,
    });

    await expect(getBotScanEvaluationSummaries([41])).resolves.toEqual(new Map([[41, expect.objectContaining({
      status: 'not_applicable_no_positive_arb',
      botTraderEvaluationCompleted: false,
      reason: 'No Positive Arb — BotTrader not applicable',
      candidateCount: 0,
      evaluatedCount: 0,
      placementAttemptCount: 0,
      failureCount: 0,
      missingCandidateIndexes: [],
      failingCandidateIndexes: [],
    })]]));

    const verify = createClient({ url: `file:${path.join(tempDir, 'data', 'edgefinder.db')}` });
    const [evaluation, candidateDecisions] = await Promise.all([
      verify.execute('SELECT status,completed,candidate_count,evaluated_count,placement_attempt_count,failure_count FROM bot_scan_evaluations WHERE scan_id=41'),
      verify.execute('SELECT * FROM bot_opportunity_decisions WHERE scan_id=41'),
    ]);
    verify.close();
    expect(evaluation.rows).toEqual([expect.objectContaining({
      status: 'not_applicable_no_positive_arb',
      completed: 0,
      candidate_count: 0,
      evaluated_count: 0,
      placement_attempt_count: 0,
      failure_count: 0,
    })]);
    expect(candidateDecisions.rows).toEqual([]);
  });

  it('persists and reads one truthful scan evaluation envelope with exact gap indexes', async () => {
    const { getBotScanEvaluationSummaries, getBotScanHealth } = await import('./bot-scan-consumer');
    await getBotScanHealth();
    const db = createClient({ url: `file:${path.join(tempDir, 'data', 'edgefinder.db')}` });
    await db.batch([
      {
        sql: `UPDATE scan_results SET raw_result=? WHERE id=42`,
        args: [JSON.stringify({ allArbs: [{ artist: 'A' }, { artist: 'B' }] })],
      },
      {
        sql: `INSERT INTO bot_scan_decisions
          (scan_id,idempotency_key,source,state,reason_code,reason,received_at,updated_at,attempts,placement_count,details)
          VALUES (42,'scan:42','scan_api','partial_or_unhedged','execution_outcome_unknown','leg outcome unknown',
          '2026-08-16T17:01:01.000Z','2026-08-16T17:01:02.000Z',1,0,'{"configVersion":"bot-settings-v1:test"}')`,
        args: [],
      },
      {
        sql: `INSERT INTO bot_opportunity_decisions
          (scan_id,candidate_index,market_id,outcome,strategy,state,reason_code,reason,roi_pct,apy_pct,created_at,updated_at,details,final_result)
          VALUES (42,0,'m-42','A','Buy YES Kalshi + NO PM','failed','execution_outcome_unknown','unknown',5,25,
          '2026-08-16T17:01:01.000Z','2026-08-16T17:01:02.000Z','{"stage":"execution","final":true}','failed')`,
        args: [],
      },
    ], 'write');
    db.close();

    const evaluation = (await getBotScanEvaluationSummaries([42])).get(42);
    expect(evaluation).toMatchObject({
      status: 'partial', botTraderEvaluationCompleted: false,
      settingsVersion: 'bot-settings-v1:test', candidateCount: 2, evaluatedCount: 1,
      failureCount: 1, missingCandidateIndexes: [1], failingCandidateIndexes: [0],
    });

    const verify = createClient({ url: `file:${path.join(tempDir, 'data', 'edgefinder.db')}` });
    const persisted = await verify.execute('SELECT * FROM bot_scan_evaluations WHERE scan_id=42');
    verify.close();
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({ status: 'partial', candidate_count: 2, evaluated_count: 1 });
  });

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
      latestCompletedScanId: 42,
      latestPositiveScanId: 42,
      latestDecisionScanId: 42,
      opportunitiesEvaluated: 1,
      eligibleCount: 1,
      lastExecutionOrSkip: { scanId: 41, state: 'criteria_rejected', reason: 'No opportunities' },
      inProgress: { scanId: 42, state: 'received' },
    });
  });
});