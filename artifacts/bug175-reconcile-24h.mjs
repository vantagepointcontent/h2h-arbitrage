import { createClient } from '@libsql/client';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const outputPath = path.join(root, 'artifacts', 'bug175-24h-reconciliation.json');
const client = createClient({ url: `file:${path.join(root, 'data', 'edgefinder.db')}` });
const run = async (sql, args = []) => (await client.execute({ sql, args })).rows;
try {
  const thresholdRow = (await run("SELECT value FROM settings WHERE key='bot.minRoiPct' LIMIT 1"))[0];
  const thresholdPct = Number(thresholdRow?.value ?? 2);
  const summary = (await run(`SELECT
      COUNT(DISTINCT s.id) AS completed_scans,
      COUNT(DISTINCT CASE WHEN s.best_roi_pct >= ? THEN s.id END) AS logs_rows_at_or_above_threshold,
      COUNT(DISTINCT CASE WHEN s.best_roi_pct >= ? AND d.scan_id IS NULL THEN s.id END) AS threshold_rows_without_scan_decision,
      COUNT(DISTINCT CASE WHEN d.scan_id IS NULL THEN s.id END) AS all_completed_rows_without_scan_decision,
      COUNT(DISTINCT CASE WHEN d.state='placed' THEN s.id END) AS placed_scans
    FROM scan_results s
    LEFT JOIN bot_scan_decisions d ON d.scan_id=s.id
    WHERE s.scan_status='completed' AND s.scanned_at >= datetime('now','-24 hours')`, [thresholdPct, thresholdPct]))[0];
  const candidateSummary = (await run(`SELECT
      COUNT(*) AS audited_candidates,
      SUM(CASE WHEN roi_pct >= ? THEN 1 ELSE 0 END) AS candidates_at_or_above_threshold,
      SUM(CASE WHEN roi_pct >= ? AND state='accepted' THEN 1 ELSE 0 END) AS accepted_at_or_above_threshold,
      SUM(CASE WHEN roi_pct >= ? AND state<>'accepted' THEN 1 ELSE 0 END) AS not_accepted_at_or_above_threshold
    FROM bot_opportunity_decisions o
    JOIN scan_results s ON s.id=o.scan_id
    WHERE s.scan_status='completed' AND s.scanned_at >= datetime('now','-24 hours')`, [thresholdPct, thresholdPct, thresholdPct]))[0];
  const reasons = await run(`SELECT o.reason_code, o.reason, COUNT(*) AS candidates,
      MIN(o.roi_pct) AS min_roi_pct, MAX(o.roi_pct) AS max_roi_pct
    FROM bot_opportunity_decisions o
    JOIN scan_results s ON s.id=o.scan_id
    WHERE s.scan_status='completed' AND s.scanned_at >= datetime('now','-24 hours')
      AND o.roi_pct >= ? AND o.state<>'accepted'
    GROUP BY o.reason_code, o.reason ORDER BY candidates DESC, o.reason_code LIMIT 100`, [thresholdPct]);
  const gaps = await run(`SELECT s.id AS scan_id, s.market_id, s.scanned_at, s.best_roi_pct, s.positive_arb_count
    FROM scan_results s LEFT JOIN bot_scan_decisions d ON d.scan_id=s.id
    WHERE s.scan_status='completed' AND s.scanned_at >= datetime('now','-24 hours')
      AND s.best_roi_pct >= ? AND d.scan_id IS NULL ORDER BY s.id`, [thresholdPct]);
  const scanStatusCandidateAuditGaps = await run(`WITH persisted_candidates AS (
      SELECT s.id AS scan_id, d.state AS scan_state, d.reason_code AS scan_reason_code,
        CAST(candidate.key AS INTEGER) AS candidate_index,
        json_extract(candidate.value, '$.artist') AS outcome,
        json_extract(candidate.value, '$.roiPct') AS roi_pct
      FROM scan_results s
      JOIN bot_scan_decisions d ON d.scan_id=s.id
      JOIN json_each(json_extract(s.raw_result, '$.allArbs')) candidate
      WHERE s.scan_status='completed' AND json_valid(s.raw_result)
        AND d.state IN ('disabled','stale')
    )
    SELECT p.scan_state, COUNT(DISTINCT p.scan_id) AS persisted_scans,
      COUNT(*) AS persisted_candidates,
      COUNT(DISTINCT CASE WHEN o.scan_id IS NULL THEN p.scan_id END) AS scans_with_missing_candidate_audits,
      SUM(CASE WHEN o.scan_id IS NULL THEN 1 ELSE 0 END) AS missing_candidate_audits
    FROM persisted_candidates p
    LEFT JOIN bot_opportunity_decisions o
      ON o.scan_id=p.scan_id AND o.candidate_index=p.candidate_index
    GROUP BY p.scan_state ORDER BY p.scan_state`);
  const scanStatusCandidateAuditGapSamples = await run(`WITH persisted_candidates AS (
      SELECT s.id AS scan_id, s.market_id, s.scanned_at, d.state AS scan_state,
        d.reason_code AS scan_reason_code, CAST(candidate.key AS INTEGER) AS candidate_index,
        json_extract(candidate.value, '$.artist') AS outcome,
        json_extract(candidate.value, '$.roiPct') AS roi_pct
      FROM scan_results s
      JOIN bot_scan_decisions d ON d.scan_id=s.id
      JOIN json_each(json_extract(s.raw_result, '$.allArbs')) candidate
      WHERE s.scan_status='completed' AND json_valid(s.raw_result)
        AND d.state IN ('disabled','stale')
    )
    SELECT p.* FROM persisted_candidates p
    LEFT JOIN bot_opportunity_decisions o
      ON o.scan_id=p.scan_id AND o.candidate_index=p.candidate_index
    WHERE o.scan_id IS NULL ORDER BY p.scan_id DESC, p.candidate_index LIMIT 100`);
  const report = {
    revision: 2,
    generatedAt: new Date().toISOString(),
    windowHours: 24,
    thresholdPct,
    policy: 'Read-only reconciliation. Historical/stale opportunities were not submitted or replayed.',
    summary,
    candidateSummary,
    thresholdQualifiedSkipReasons: reasons,
    unprocessedThresholdRows: gaps,
    scanStatusCandidateAuditGaps,
    scanStatusCandidateAuditGapSamples,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    summary,
    candidateSummary,
    distinctSkipReasons: reasons.length,
    gapSamples: gaps.length,
    scanStatusCandidateAuditGaps,
  }, null, 2));
} finally { client.close(); }
