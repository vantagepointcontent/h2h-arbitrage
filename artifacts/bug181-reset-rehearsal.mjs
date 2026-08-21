import { createClient } from '@libsql/client';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'bug181-reset-rehearsal-'));
const db = createClient({ url: `file:${path.join(directory, 'rehearsal.db')}` });
try {
  await db.batch([
    `CREATE TABLE scan_results (id INTEGER PRIMARY KEY, market_id TEXT, scan_status TEXT,
      positive_arb_count INTEGER, raw_result TEXT)`,
    `CREATE TABLE bot_scan_decisions (scan_id INTEGER PRIMARY KEY, state TEXT, reason_code TEXT,
      reason TEXT, updated_at TEXT)`,
    `CREATE TABLE bot_opportunity_decisions (scan_id INTEGER, candidate_index INTEGER, market_id TEXT,
      outcome TEXT, strategy TEXT, state TEXT, reason_code TEXT, reason TEXT, roi_pct REAL, apy_pct REAL,
      created_at TEXT, updated_at TEXT, details TEXT, opportunity_id TEXT, threshold_config_version TEXT,
      final_result TEXT, execution_id INTEGER, PRIMARY KEY(scan_id,candidate_index))`,
    `CREATE TABLE bot_scan_evaluations (scan_id INTEGER PRIMARY KEY, status TEXT, completed INTEGER,
      reason TEXT, completed_at TEXT, updated_at TEXT, candidate_count INTEGER, evaluated_count INTEGER,
      eligible_count INTEGER, placement_attempt_count INTEGER, placed_count INTEGER, skipped_count INTEGER,
      failure_count INTEGER, missing_candidate_indexes TEXT, failing_candidate_indexes TEXT)`,
  ], 'write');
  const reason = 'Cleared by OPS-854 reset baseline. Original state is retained in audit backup.';
  await db.batch([
    { sql: `INSERT INTO scan_results VALUES (1,'market-1','completed',2,?)`, args: [JSON.stringify({ allArbs: [
      { artist: 'A', strategy: 'Buy YES Kalshi + NO PM', roiPct: 2, apyPct: 20 },
      { artist: 'B', strategy: 'Buy NO Kalshi + YES PM', roiPct: 1, apyPct: 10 },
    ] })] },
    { sql: `INSERT INTO scan_results VALUES (2,'market-2','completed',1,'{malformed')`, args: [] },
    { sql: `INSERT INTO scan_results VALUES (3,'market-3','completed',2,'{"other":true}')`, args: [] },
    { sql: `INSERT INTO scan_results VALUES (4,'market-4','completed',2,'{"allArbs":[null,"bad"]}')`, args: [] },
    { sql: `INSERT INTO scan_results VALUES (5,'market-5','completed',1,'{"allArbs":5}')`, args: [] },
    { sql: `INSERT INTO bot_scan_decisions VALUES (1,'reset_cleared','ops854_reset_cleared',?,'2026-08-20T10:00:00.000Z')`, args: [reason] },
    { sql: `INSERT INTO bot_scan_decisions VALUES (2,'reset_cleared','ops854_reset_cleared',?,'2026-08-20T10:00:00.000Z')`, args: [reason] },
    { sql: `INSERT INTO bot_scan_decisions VALUES (3,'reset_cleared','ops854_reset_cleared',?,'2026-08-20T10:00:00.000Z')`, args: [reason] },
    { sql: `INSERT INTO bot_scan_decisions VALUES (4,'reset_cleared','ops854_reset_cleared',?,'2026-08-20T10:00:00.000Z')`, args: [reason] },
    { sql: `INSERT INTO bot_scan_decisions VALUES (5,'reset_cleared','ops854_reset_cleared',?,'2026-08-20T10:00:00.000Z')`, args: [reason] },
    { sql: `INSERT INTO bot_scan_evaluations VALUES (1,'failed',0,'old',NULL,NULL,2,0,0,0,0,0,0,'[0,1]','[]')`, args: [] },
    { sql: `INSERT INTO bot_scan_evaluations VALUES (2,'failed',0,'old',NULL,NULL,1,0,0,0,0,0,0,'[0]','[]')`, args: [] },
    { sql: `INSERT INTO bot_scan_evaluations VALUES (3,'failed',0,'old',NULL,NULL,2,0,0,0,0,0,0,'[0,1]','[]')`, args: [] },
    { sql: `INSERT INTO bot_scan_evaluations VALUES (4,'failed',0,'old',NULL,NULL,2,0,0,0,0,0,0,'[0,1]','[]')`, args: [] },
    { sql: `INSERT INTO bot_scan_evaluations VALUES (5,'failed',0,'old',NULL,NULL,1,0,0,0,0,0,0,'[0]','[]')`, args: [] },
  ], 'write');

  await db.execute(`INSERT OR IGNORE INTO bot_opportunity_decisions
    (scan_id,candidate_index,market_id,outcome,strategy,state,reason_code,reason,
     roi_pct,apy_pct,created_at,updated_at,details,opportunity_id,
     threshold_config_version,final_result,execution_id)
    SELECT s.id,CAST(candidate.key AS INTEGER),s.market_id,
      CASE WHEN candidate.type='object' THEN COALESCE(json_extract(candidate.value,'$.artist'),'unknown') ELSE 'unknown' END,
      CASE WHEN candidate.type='object' THEN COALESCE(json_extract(candidate.value,'$.strategy'),'unknown') ELSE 'unknown' END,
      CASE WHEN candidate.type='object' THEN 'skipped' ELSE 'failed' END,
      CASE WHEN candidate.type='object' THEN 'ops854_reset_cleared' ELSE 'reset_candidate_payload_unavailable' END,
      d.reason || CASE WHEN candidate.type='object' THEN ''
        ELSE ' Candidate payload is malformed, so exact candidate fields are unavailable.' END,
      CASE WHEN candidate.type='object' THEN json_extract(candidate.value,'$.roiPct') ELSE NULL END,
      CASE WHEN candidate.type='object' THEN json_extract(candidate.value,'$.apyPct') ELSE NULL END,
      d.updated_at,d.updated_at,
      json_object('schemaVersion',1,'stage','operator_reset','final',1,
        'resetReasonCode',d.reason_code,'payloadUnavailable',CASE WHEN candidate.type='object' THEN 0 ELSE 1 END),
      'scan:' || s.id || ':opportunity:' || candidate.key,
      NULL,'reset_cleared',NULL
    FROM scan_results s
    JOIN bot_scan_decisions d ON d.scan_id=s.id
    JOIN json_each(CASE WHEN json_valid(s.raw_result)
      AND json_type(s.raw_result,'$.allArbs')='array' THEN s.raw_result
      ELSE '{"allArbs":[]}' END,'$.allArbs') candidate
    WHERE d.state='reset_cleared' AND d.reason_code='ops854_reset_cleared'
      AND s.scan_status='completed' AND s.positive_arb_count>0
      AND json_valid(s.raw_result) AND json_type(s.raw_result,'$.allArbs')='array'`);
  await db.execute(`WITH RECURSIVE reset_missing
    (scan_id,market_id,reason,reason_code,updated_at,candidate_index,candidate_count) AS (
      SELECT s.id,s.market_id,d.reason,d.reason_code,d.updated_at,0,s.positive_arb_count
      FROM scan_results s JOIN bot_scan_decisions d ON d.scan_id=s.id
      WHERE d.state='reset_cleared' AND d.reason_code='ops854_reset_cleared'
        AND s.scan_status='completed' AND s.positive_arb_count>0
        AND CASE WHEN json_valid(s.raw_result)
          THEN COALESCE(json_type(s.raw_result,'$.allArbs'),'missing') ELSE 'invalid' END<>'array'
      UNION ALL
      SELECT scan_id,market_id,reason,reason_code,updated_at,candidate_index+1,candidate_count
      FROM reset_missing WHERE candidate_index+1<candidate_count
    )
    INSERT OR IGNORE INTO bot_opportunity_decisions
      (scan_id,candidate_index,market_id,outcome,strategy,state,reason_code,reason,
       roi_pct,apy_pct,created_at,updated_at,details,opportunity_id,
       threshold_config_version,final_result,execution_id)
    SELECT scan_id,candidate_index,market_id,'unknown','unknown','failed',
      'reset_candidate_payload_unavailable',
      reason || ' Candidate payload is malformed, so exact candidate fields are unavailable.',
      NULL,NULL,updated_at,updated_at,
      json_object('schemaVersion',1,'stage','operator_reset','final',1,
        'resetReasonCode',reason_code,'payloadUnavailable',1),
      'scan:' || scan_id || ':opportunity:' || candidate_index,
      NULL,'reset_cleared',NULL
    FROM reset_missing`);
  await db.execute(`UPDATE bot_scan_evaluations SET
    status='completed', completed=1,
    reason=(SELECT d.reason FROM bot_scan_decisions d WHERE d.scan_id=bot_scan_evaluations.scan_id),
    completed_at=(SELECT d.updated_at FROM bot_scan_decisions d WHERE d.scan_id=bot_scan_evaluations.scan_id),
    updated_at=(SELECT d.updated_at FROM bot_scan_decisions d WHERE d.scan_id=bot_scan_evaluations.scan_id),
    candidate_count=(SELECT CASE WHEN json_valid(s.raw_result)
      AND json_type(s.raw_result,'$.allArbs')='array'
      THEN COALESCE(json_array_length(json_extract(s.raw_result,'$.allArbs')),s.positive_arb_count)
      ELSE s.positive_arb_count END FROM scan_results s WHERE s.id=bot_scan_evaluations.scan_id),
    evaluated_count=(SELECT CASE WHEN json_valid(s.raw_result)
      AND json_type(s.raw_result,'$.allArbs')='array'
      THEN COALESCE(json_array_length(json_extract(s.raw_result,'$.allArbs')),s.positive_arb_count)
      ELSE s.positive_arb_count END FROM scan_results s WHERE s.id=bot_scan_evaluations.scan_id),
    eligible_count=0, placement_attempt_count=0, placed_count=0,
    skipped_count=(SELECT CASE WHEN json_valid(s.raw_result)
      AND json_type(s.raw_result,'$.allArbs')='array'
      THEN COALESCE(json_array_length(json_extract(s.raw_result,'$.allArbs')),s.positive_arb_count)
      ELSE s.positive_arb_count END FROM scan_results s WHERE s.id=bot_scan_evaluations.scan_id),
    failure_count=0, missing_candidate_indexes='[]', failing_candidate_indexes='[]'
    WHERE scan_id IN (SELECT scan_id FROM bot_scan_decisions
      WHERE state='reset_cleared' AND reason_code='ops854_reset_cleared')
      AND (completed<>1 OR status<>'completed')`);

  const candidates = await db.execute('SELECT * FROM bot_opportunity_decisions ORDER BY candidate_index');
  const evaluations = await db.execute('SELECT * FROM bot_scan_evaluations ORDER BY scan_id');
  const integrity = await db.execute('PRAGMA integrity_check');
  if (candidates.rows.length !== 8 || candidates.rows.some((row) => row.final_result !== 'reset_cleared')) {
    throw new Error('Reset candidate audit rehearsal did not create eight terminal reset tombstones');
  }
  if (evaluations.rows.some((row) => row.completed !== 1 || row.status !== 'completed')) {
    throw new Error('Reset evaluation rehearsal did not close every scan-level tombstone');
  }
  console.log(JSON.stringify({ candidateAudits: candidates.rows.length, evaluations: evaluations.rows, integrity: integrity.rows[0] }, null, 2));
} finally {
  db.close();
  await rm(directory, { recursive: true, force: true });
}
