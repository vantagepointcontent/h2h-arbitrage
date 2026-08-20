import { createClient } from '@libsql/client';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const deployedAt = process.argv[2];
if (!deployedAt || !Number.isFinite(Date.parse(deployedAt))) throw new Error('Pass deployment ISO timestamp');
const outputPath = path.join(root, 'artifacts', 'bug175-production-verification.json');
const client = createClient({ url: `file:${path.join(root, 'data', 'edgefinder.db')}` });
const run = async (sql, args = []) => (await client.execute({ sql, args })).rows;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const threshold = Number((await run("SELECT value FROM settings WHERE key='bot.minRoiPct'"))[0]?.value ?? 2);
  let scan;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    scan = (await run(`SELECT s.id, s.market_id, s.market_title, s.scanned_at, s.best_roi_pct, s.positive_arb_count,
        d.state, d.reason_code, d.reason, d.received_at, d.updated_at, d.placement_count
      FROM scan_results s JOIN bot_scan_decisions d ON d.scan_id=s.id
      WHERE s.scan_status='completed' AND s.scanned_at >= ? AND s.best_roi_pct >= ?
      ORDER BY s.id ASC LIMIT 1`, [deployedAt, threshold]))[0];
    if (scan) break;
    await sleep(5_000);
  }
  if (!scan) throw new Error('No post-deployment qualifying completed Logs scan was observed within five minutes');
  const opportunities = await run(`SELECT opportunity_id, candidate_index, outcome, strategy, state, reason_code, reason,
      roi_pct, apy_pct, threshold_config_version, final_result, execution_id, created_at, updated_at, details
    FROM bot_opportunity_decisions WHERE scan_id=? ORDER BY candidate_index`, [scan.id]);
  const executions = await run(`SELECT id, timestamp, arb_id, success, source, source_scan_id, source_opportunity_id
    FROM executions WHERE source_scan_id=? ORDER BY id`, [scan.id]);
  const eventCounts = await run(`SELECT state, reason_code, COUNT(*) AS count
    FROM bot_scan_decision_events WHERE scan_id=? GROUP BY state, reason_code ORDER BY state, reason_code`, [scan.id]);
  const duplicateDecisionRows = Number((await run(
    'SELECT COUNT(*) AS count FROM bot_scan_decisions WHERE scan_id=?', [scan.id],
  ))[0]?.count ?? 0) - 1;
  const parsedOpportunities = opportunities.map((row) => ({
    ...row,
    details: typeof row.details === 'string' ? JSON.parse(row.details) : null,
  }));
  const report = {
    revision: 1,
    verifiedAt: new Date().toISOString(),
    deployedAt,
    thresholdPct: threshold,
    safetyStatement: 'Read-only verification; no stale historical opportunity was submitted.',
    scan,
    decisionLatencyMs: Date.parse(String(scan.received_at)) - Date.parse(String(scan.scanned_at)),
    opportunities: parsedOpportunities,
    executions,
    eventCounts,
    duplicateDecisionRows,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    scanId: scan.id,
    bestRoiPct: scan.best_roi_pct,
    decisionState: scan.state,
    reasonCode: scan.reason_code,
    reason: scan.reason,
    decisionLatencyMs: report.decisionLatencyMs,
    opportunities: parsedOpportunities.map((row) => ({ opportunityId: row.opportunity_id, roiPct: row.roi_pct, state: row.state, reasonCode: row.reason_code, reason: row.reason, executionId: row.execution_id })),
    executions,
    eventCounts,
    duplicateDecisionRows,
  }, null, 2));
} finally { client.close(); }
