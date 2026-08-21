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
    `CREATE TABLE bot_consumer_schema_migrations (name TEXT PRIMARY KEY, completed_at TEXT NOT NULL)`,
  ], 'write');
  const reason = 'Cleared by OPS-854 reset baseline. Original state is retained in audit backup.';
  await db.batch([
    { sql: `INSERT INTO scan_results VALUES (1,'market-1','completed',2,?)`, args: [JSON.stringify({ allArbs: [
      { artist: 'A', strategy: 'Buy YES Kalshi + NO PM', roiPct: 2, apyPct: 20, expectedProfit: 2, kalshiTicker: 'K-A', pmConditionId: 'pm-a' },
      { artist: 'B', strategy: 'Buy NO Kalshi + YES PM', roiPct: 1, apyPct: 10, expectedProfit: 1, kalshiTicker: 'K-B', pmConditionId: 'pm-b' },
    ] })] },
    { sql: `INSERT INTO scan_results VALUES (2,'market-2','completed',1,'{malformed')`, args: [] },
    { sql: `INSERT INTO scan_results VALUES (3,'market-3','completed',2,'{"other":true}')`, args: [] },
    { sql: `INSERT INTO scan_results VALUES (4,'market-4','completed',2,'{"allArbs":[{},"bad"]}')`, args: [] },
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
    { sql: `INSERT INTO bot_opportunity_decisions
      (scan_id,candidate_index,market_id,outcome,strategy,state,reason_code,reason,
       created_at,updated_at,details,final_result)
      VALUES (4,0,'market-4','unknown','unknown','skipped','ops854_reset_cleared','incorrect prior audit',
      '2026-08-20T10:00:00.000Z','2026-08-20T10:00:00.000Z',
      '{"schemaVersion":1,"stage":"operator_reset","final":1,"payloadUnavailable":0}','reset_cleared')`, args: [] },
  ], 'write');

  await db.execute(`INSERT OR IGNORE INTO bot_opportunity_decisions
    (scan_id,candidate_index,market_id,outcome,strategy,state,reason_code,reason,
     roi_pct,apy_pct,created_at,updated_at,details,opportunity_id,
     threshold_config_version,final_result,execution_id)
    SELECT s.id,CAST(candidate.key AS INTEGER),s.market_id,
      CASE WHEN candidate.type='object' AND json_type(candidate.value,'$.artist')='text'
        AND json_type(candidate.value,'$.strategy')='text' THEN json_extract(candidate.value,'$.artist') ELSE 'unknown' END,
      CASE WHEN candidate.type='object' AND json_type(candidate.value,'$.artist')='text'
        AND json_type(candidate.value,'$.strategy')='text' THEN json_extract(candidate.value,'$.strategy') ELSE 'unknown' END,
      CASE WHEN candidate.type='object'
        AND json_type(candidate.value,'$.artist')='text' AND length(trim(json_extract(candidate.value,'$.artist')))>0
        AND json_type(candidate.value,'$.strategy')='text' AND length(trim(json_extract(candidate.value,'$.strategy')))>0
        AND json_type(candidate.value,'$.roiPct') IN ('integer','real')
        AND json_type(candidate.value,'$.expectedProfit') IN ('integer','real')
        AND json_type(candidate.value,'$.kalshiTicker')='text' AND length(trim(json_extract(candidate.value,'$.kalshiTicker')))>0
        AND json_type(candidate.value,'$.pmConditionId')='text' AND length(trim(json_extract(candidate.value,'$.pmConditionId')))>0
        THEN 'skipped' ELSE 'failed' END,
      CASE WHEN candidate.type='object'
        AND json_type(candidate.value,'$.artist')='text' AND length(trim(json_extract(candidate.value,'$.artist')))>0
        AND json_type(candidate.value,'$.strategy')='text' AND length(trim(json_extract(candidate.value,'$.strategy')))>0
        AND json_type(candidate.value,'$.roiPct') IN ('integer','real')
        AND json_type(candidate.value,'$.expectedProfit') IN ('integer','real')
        AND json_type(candidate.value,'$.kalshiTicker')='text' AND length(trim(json_extract(candidate.value,'$.kalshiTicker')))>0
        AND json_type(candidate.value,'$.pmConditionId')='text' AND length(trim(json_extract(candidate.value,'$.pmConditionId')))>0
        THEN 'ops854_reset_cleared' ELSE 'reset_candidate_payload_unavailable' END,
      d.reason || CASE WHEN candidate.type='object'
        AND json_type(candidate.value,'$.artist')='text' AND length(trim(json_extract(candidate.value,'$.artist')))>0
        AND json_type(candidate.value,'$.strategy')='text' AND length(trim(json_extract(candidate.value,'$.strategy')))>0
        AND json_type(candidate.value,'$.roiPct') IN ('integer','real')
        AND json_type(candidate.value,'$.expectedProfit') IN ('integer','real')
        AND json_type(candidate.value,'$.kalshiTicker')='text' AND length(trim(json_extract(candidate.value,'$.kalshiTicker')))>0
        AND json_type(candidate.value,'$.pmConditionId')='text' AND length(trim(json_extract(candidate.value,'$.pmConditionId')))>0 THEN ''
        ELSE ' Candidate payload is malformed, so exact candidate fields are unavailable.' END,
      CASE WHEN candidate.type='object' THEN json_extract(candidate.value,'$.roiPct') ELSE NULL END,
      CASE WHEN candidate.type='object' THEN json_extract(candidate.value,'$.apyPct') ELSE NULL END,
      d.updated_at,d.updated_at,
      json_object('schemaVersion',1,'stage','operator_reset','final',1,
        'resetReasonCode',d.reason_code,'payloadUnavailable',CASE WHEN candidate.type='object'
          AND json_type(candidate.value,'$.artist')='text' AND length(trim(json_extract(candidate.value,'$.artist')))>0
          AND json_type(candidate.value,'$.strategy')='text' AND length(trim(json_extract(candidate.value,'$.strategy')))>0
          AND json_type(candidate.value,'$.roiPct') IN ('integer','real')
          AND json_type(candidate.value,'$.expectedProfit') IN ('integer','real')
          AND json_type(candidate.value,'$.kalshiTicker')='text' AND length(trim(json_extract(candidate.value,'$.kalshiTicker')))>0
          AND json_type(candidate.value,'$.pmConditionId')='text' AND length(trim(json_extract(candidate.value,'$.pmConditionId')))>0
          THEN 0 ELSE 1 END),
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
  await db.execute(`WITH reset_candidates AS (
    SELECT o.scan_id,o.candidate_index,d.reason,d.reason_code,d.updated_at,candidate.value,
      CASE WHEN candidate.type='object'
        AND json_type(candidate.value,'$.artist')='text' AND length(trim(json_extract(candidate.value,'$.artist')))>0
        AND json_type(candidate.value,'$.strategy')='text' AND length(trim(json_extract(candidate.value,'$.strategy')))>0
        AND json_type(candidate.value,'$.roiPct') IN ('integer','real')
        AND json_type(candidate.value,'$.expectedProfit') IN ('integer','real')
        AND json_type(candidate.value,'$.kalshiTicker')='text' AND length(trim(json_extract(candidate.value,'$.kalshiTicker')))>0
        AND json_type(candidate.value,'$.pmConditionId')='text' AND length(trim(json_extract(candidate.value,'$.pmConditionId')))>0
        THEN 1 ELSE 0 END AS audit_valid
    FROM bot_opportunity_decisions o
    JOIN scan_results s ON s.id=o.scan_id
    JOIN bot_scan_decisions d ON d.scan_id=o.scan_id
    JOIN json_each(CASE WHEN json_valid(s.raw_result)
      AND json_type(s.raw_result,'$.allArbs')='array' THEN s.raw_result
      ELSE '{"allArbs":[]}' END,'$.allArbs') candidate
      ON CAST(candidate.key AS INTEGER)=o.candidate_index
    WHERE d.state='reset_cleared' AND d.reason_code='ops854_reset_cleared'
      AND o.final_result='reset_cleared'
  )
  UPDATE bot_opportunity_decisions SET
    outcome=CASE WHEN (SELECT audit_valid FROM reset_candidates r
      WHERE r.scan_id=bot_opportunity_decisions.scan_id AND r.candidate_index=bot_opportunity_decisions.candidate_index)=1
      THEN json_extract((SELECT value FROM reset_candidates r WHERE r.scan_id=bot_opportunity_decisions.scan_id
        AND r.candidate_index=bot_opportunity_decisions.candidate_index),'$.artist') ELSE 'unknown' END,
    strategy=CASE WHEN (SELECT audit_valid FROM reset_candidates r
      WHERE r.scan_id=bot_opportunity_decisions.scan_id AND r.candidate_index=bot_opportunity_decisions.candidate_index)=1
      THEN json_extract((SELECT value FROM reset_candidates r WHERE r.scan_id=bot_opportunity_decisions.scan_id
        AND r.candidate_index=bot_opportunity_decisions.candidate_index),'$.strategy') ELSE 'unknown' END,
    state=CASE WHEN (SELECT audit_valid FROM reset_candidates r
      WHERE r.scan_id=bot_opportunity_decisions.scan_id AND r.candidate_index=bot_opportunity_decisions.candidate_index)=1
      THEN 'skipped' ELSE 'failed' END,
    reason_code=CASE WHEN (SELECT audit_valid FROM reset_candidates r
      WHERE r.scan_id=bot_opportunity_decisions.scan_id AND r.candidate_index=bot_opportunity_decisions.candidate_index)=1
      THEN 'ops854_reset_cleared' ELSE 'reset_candidate_payload_unavailable' END,
    reason=(SELECT reason || CASE WHEN audit_valid=1 THEN ''
      ELSE ' Candidate payload is malformed, so exact candidate fields are unavailable.' END
      FROM reset_candidates r WHERE r.scan_id=bot_opportunity_decisions.scan_id
        AND r.candidate_index=bot_opportunity_decisions.candidate_index),
    details=(SELECT json_object('schemaVersion',1,'stage','operator_reset','final',1,
      'resetReasonCode',reason_code,'payloadUnavailable',CASE WHEN audit_valid=1 THEN 0 ELSE 1 END)
      FROM reset_candidates r WHERE r.scan_id=bot_opportunity_decisions.scan_id
        AND r.candidate_index=bot_opportunity_decisions.candidate_index),
    updated_at=(SELECT updated_at FROM reset_candidates r WHERE r.scan_id=bot_opportunity_decisions.scan_id
      AND r.candidate_index=bot_opportunity_decisions.candidate_index)
  WHERE EXISTS (SELECT 1 FROM reset_candidates r WHERE r.scan_id=bot_opportunity_decisions.scan_id
    AND r.candidate_index=bot_opportunity_decisions.candidate_index)`);
  await db.execute(`UPDATE bot_scan_evaluations SET
    status=CASE WHEN EXISTS (SELECT 1 FROM bot_opportunity_decisions o
      WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed'))
      THEN 'failed' ELSE 'completed' END,
    completed=CASE WHEN EXISTS (SELECT 1 FROM bot_opportunity_decisions o
      WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed'))
      THEN 0 ELSE 1 END,
    reason=(SELECT d.reason FROM bot_scan_decisions d WHERE d.scan_id=bot_scan_evaluations.scan_id),
    completed_at=(SELECT d.updated_at FROM bot_scan_decisions d WHERE d.scan_id=bot_scan_evaluations.scan_id),
    updated_at=(SELECT d.updated_at FROM bot_scan_decisions d WHERE d.scan_id=bot_scan_evaluations.scan_id),
    candidate_count=(SELECT CASE WHEN json_valid(s.raw_result)
      AND json_type(s.raw_result,'$.allArbs')='array'
      THEN COALESCE(json_array_length(json_extract(s.raw_result,'$.allArbs')),s.positive_arb_count)
      ELSE s.positive_arb_count END FROM scan_results s WHERE s.id=bot_scan_evaluations.scan_id),
    evaluated_count=(SELECT COUNT(*) FROM bot_opportunity_decisions o
      WHERE o.scan_id=bot_scan_evaluations.scan_id AND o.final_result IS NOT NULL),
    eligible_count=0, placement_attempt_count=0, placed_count=0,
    skipped_count=(SELECT COUNT(*) FROM bot_opportunity_decisions o
      WHERE o.scan_id=bot_scan_evaluations.scan_id AND o.final_result IS NOT NULL
        AND o.state<>'failed' AND o.final_result NOT IN ('failed','accepted')),
    failure_count=(SELECT COUNT(*) FROM bot_opportunity_decisions o
      WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed')),
    missing_candidate_indexes='[]',
    failing_candidate_indexes=COALESCE((SELECT json_group_array(candidate_index) FROM
      (SELECT candidate_index FROM bot_opportunity_decisions o
        WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed')
        ORDER BY candidate_index)), '[]')
    WHERE scan_id IN (SELECT scan_id FROM bot_scan_decisions
      WHERE state='reset_cleared' AND reason_code='ops854_reset_cleared')`);
  await db.execute({
    sql: `INSERT INTO bot_consumer_schema_migrations(name,completed_at) VALUES (?,?)`,
    args: ['bug181-reset-candidate-reconciliation-v2', new Date().toISOString()],
  });

  const candidates = await db.execute('SELECT * FROM bot_opportunity_decisions ORDER BY candidate_index');
  const evaluations = await db.execute('SELECT * FROM bot_scan_evaluations ORDER BY scan_id');
  const integrity = await db.execute('PRAGMA integrity_check');
  const migrations = await db.execute('SELECT name FROM bot_consumer_schema_migrations');
  if (candidates.rows.length !== 8 || candidates.rows.some((row) => row.final_result !== 'reset_cleared')) {
    throw new Error('Reset candidate audit rehearsal did not create eight terminal reset tombstones');
  }
  const auditsByScan = Map.groupBy(candidates.rows, (row) => row.scan_id);
  for (const evaluation of evaluations.rows) {
    const audits = auditsByScan.get(evaluation.scan_id) ?? [];
    const failing = audits.filter((row) => row.state === 'failed').map((row) => row.candidate_index);
    const skipped = audits.filter((row) => row.state !== 'failed' && row.final_result !== 'accepted');
    if (evaluation.evaluated_count !== audits.length
      || evaluation.failure_count !== failing.length
      || evaluation.skipped_count !== skipped.length
      || evaluation.failing_candidate_indexes !== JSON.stringify(failing)
      || evaluation.completed !== (failing.length === 0 ? 1 : 0)
      || evaluation.status !== (failing.length === 0 ? 'completed' : 'failed')) {
      throw new Error(`Reset evaluation ${evaluation.scan_id} does not reconcile with its candidate audits`);
    }
  }
  if (migrations.rows[0]?.name !== 'bug181-reset-candidate-reconciliation-v2') {
    throw new Error('Reset reconciliation completion marker was not persisted');
  }
  console.log(JSON.stringify({ candidateAudits: candidates.rows.length, evaluations: evaluations.rows, integrity: integrity.rows[0] }, null, 2));
} finally {
  db.close();
  await rm(directory, { recursive: true, force: true });
}
