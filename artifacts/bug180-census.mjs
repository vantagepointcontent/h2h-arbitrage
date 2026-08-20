import { createClient } from '@libsql/client';

const dbPath = process.env.H2H_SQLITE_PATH || 'data/edgefinder.db';
const client = createClient({ url: `file:${dbPath}` });
const queries = {
  scanPopulation: `SELECT COUNT(*) AS total,
    SUM(CASE WHEN positive_arb_count > 0 THEN 1 ELSE 0 END) AS positive_arb_rows,
    SUM(CASE WHEN best_roi_pct > 0 THEN 1 ELSE 0 END) AS positive_roi_rows,
    SUM(CASE WHEN best_roi_pct = 0 THEN 1 ELSE 0 END) AS zero_roi_rows,
    SUM(CASE WHEN best_roi_pct IS NULL THEN 1 ELSE 0 END) AS null_roi_rows,
    SUM(CASE WHEN raw_result LIKE '%"roiPct":%' THEN 1 ELSE 0 END) AS rows_with_raw_roi
    FROM scan_results`,
  recentScans: `SELECT COUNT(*) AS total,
    SUM(CASE WHEN positive_arb_count > 0 THEN 1 ELSE 0 END) AS positive_arb_rows,
    SUM(CASE WHEN best_roi_pct > 0 THEN 1 ELSE 0 END) AS positive_roi_rows,
    SUM(CASE WHEN best_roi_pct = 0 THEN 1 ELSE 0 END) AS zero_roi_rows,
    SUM(CASE WHEN best_roi_pct IS NULL THEN 1 ELSE 0 END) AS null_roi_rows
    FROM scan_results WHERE scanned_at >= datetime('now', '-1 day')`,
  savedMarkets: `SELECT COUNT(*) AS total,
    SUM(CASE WHEN canonical_current_roi_pct > 0 THEN 1 ELSE 0 END) AS positive_current_roi,
    SUM(CASE WHEN canonical_current_roi_pct = 0 THEN 1 ELSE 0 END) AS zero_current_roi,
    SUM(CASE WHEN canonical_current_roi_pct IS NULL THEN 1 ELSE 0 END) AS null_current_roi,
    SUM(CASE WHEN canonical_apy_pct IS NOT NULL THEN 1 ELSE 0 END) AS available_apy,
    SUM(CASE WHEN last_scan_result LIKE '%"roiPct":%' THEN 1 ELSE 0 END) AS payloads_with_roi,
    SUM(CASE WHEN last_scan_result LIKE '%"executionStatus":"executable"%' THEN 1 ELSE 0 END) AS payloads_with_executable
    FROM saved_markets`,
  scanStrategies: `SELECT strategy, arb_type, arb_valid, arb_invalidation_reason,
    COUNT(*) AS rows,
    SUM(CASE WHEN positive_arb_count > 0 THEN 1 ELSE 0 END) AS positive_arb_rows,
    SUM(CASE WHEN best_roi_pct > 0 THEN 1 ELSE 0 END) AS positive_roi_rows
    FROM scan_results GROUP BY strategy, arb_type, arb_valid, arb_invalidation_reason
    ORDER BY rows DESC LIMIT 20`,
  savedUnavailableReasons: `SELECT canonical_apy_unavailable_reason AS reason, COUNT(*) AS rows
    FROM saved_markets GROUP BY canonical_apy_unavailable_reason ORDER BY rows DESC`,
  recoverableHistorical: `SELECT COUNT(*) AS rows,
    SUM(CASE WHEN best_roi_pct = 0 AND raw_result LIKE '%"roiPct":%' THEN 1 ELSE 0 END) AS zero_scalar_with_raw_roi,
    SUM(CASE WHEN positive_arb_count = 0 AND raw_result LIKE '%"roiPct":%' THEN 1 ELSE 0 END) AS zero_count_with_raw_roi
    FROM scan_results`,
};

try {
  const report = { observedAt: new Date().toISOString(), dbPath, queries: {} };
  for (const [name, sql] of Object.entries(queries)) {
    const result = await client.execute(sql);
    report.queries[name] = result.rows;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  client.close();
}
