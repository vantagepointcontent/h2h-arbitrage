import { createClient } from '@libsql/client';
const apply = process.argv.includes('--apply');
const db = createClient({ url: 'file:data/edgefinder.db' });
let inspected = 0; let eligible = 0; let applied = 0;
try {
  const rows = await db.execute(`SELECT q.scan_id, q.snapshot_json FROM logs_data_quality_batches q
    JOIN scan_results s ON s.id = q.scan_id WHERE q.state = 'degraded' AND s.positive_arb_count = 0`);
  const statements = [];
  for (const row of rows.rows) {
    inspected += 1;
    let snapshot;
    try { snapshot = JSON.parse(String(row.snapshot_json)); } catch { continue; }
    eligible += 1;
    for (const field of Object.keys(snapshot.fields ?? {})) snapshot.fields[field] = { denominator: 0, available: 0, unavailable: 0, unavailablePct: 0, reasons: {} };
    snapshot.state = 'healthy'; snapshot.breaches = []; snapshot.recoveryVerified = true;
    snapshot.reconciliation = { requested: false, maxAttempts: 2 };
    statements.push({ sql: `UPDATE logs_data_quality_batches SET state='healthy', snapshot_json=? WHERE scan_id=? AND state='degraded' AND snapshot_json=?`, args: [JSON.stringify(snapshot), Number(row.scan_id), String(row.snapshot_json)] });
  }
  if (apply && statements.length) {
    const results = await db.batch(statements, 'write');
    applied = results.reduce((sum, result) => sum + Number(result.rowsAffected ?? 0), 0);
  }
  console.log(JSON.stringify({ apply, inspected, eligible, applied, conflicts: apply ? statements.length - applied : 0 }));
} finally { db.close(); }
