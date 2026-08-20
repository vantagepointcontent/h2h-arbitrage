import { createClient } from '@libsql/client';

const apply = process.argv.includes('--apply');
const db = createClient({ url: `file:${process.env.H2H_SQLITE_PATH || 'data/edgefinder.db'}` });
const report = { apply, inspected: 0, eligible: 0, applied: 0, conflicts: 0, reason: 'all persisted candidates explicitly non_executable with confirmed zero profit and stake' };
try {
  const result = await db.execute(`SELECT id, positive_arb_count, best_profit, total_stake, raw_result
    FROM scan_results WHERE scan_status = 'completed' AND arb_valid = 1 AND positive_arb_count > 0
      AND best_profit = 0 AND total_stake = 0 AND raw_result IS NOT NULL ORDER BY id`);
  const statements = [];
  for (const row of result.rows) {
    report.inspected += 1;
    let raw;
    try { raw = JSON.parse(String(row.raw_result)); } catch { continue; }
    const arbs = Array.isArray(raw?.allArbs) ? raw.allArbs : [];
    if (arbs.length === 0 || !arbs.every((arb) => arb && arb.executionStatus === 'non_executable'
      && arb.expectedProfit === 0 && arb.totalStake === 0)) continue;
    report.eligible += 1;
    if (apply) statements.push({
      sql: `UPDATE scan_results SET positive_arb_count = 0
        WHERE id = ? AND positive_arb_count IS ? AND best_profit IS 0 AND total_stake IS 0 AND raw_result IS ?`,
      args: [Number(row.id), Number(row.positive_arb_count), String(row.raw_result)],
    });
  }
  if (statements.length) {
    const results = await db.batch(statements, 'write');
    report.applied = results.reduce((sum, item) => sum + Number(item.rowsAffected ?? 0), 0);
    report.conflicts = statements.length - report.applied;
  }
  console.log(JSON.stringify(report));
  if (report.conflicts) process.exitCode = 2;
} finally { db.close(); }
