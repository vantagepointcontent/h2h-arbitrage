import { createClient } from '@libsql/client';

const client = createClient({ url: `file:${process.env.H2H_SQLITE_PATH || 'data/edgefinder.db'}` });
try {
  const [integrity, foreignKeys, scans, telemetry] = await Promise.all([
    client.execute('PRAGMA integrity_check'),
    client.execute('PRAGMA foreign_key_check'),
    client.execute('SELECT COUNT(*) AS count FROM scan_results'),
    client.execute('SELECT COUNT(*) AS count FROM logs_data_quality_batches'),
  ]);
  process.stdout.write(`${JSON.stringify({
    integrity: integrity.rows.map((row) => Object.values(row)[0]),
    foreignKeyViolations: foreignKeys.rows.length,
    scanResults: Number(scans.rows[0]?.count ?? 0),
    telemetryBatches: Number(telemetry.rows[0]?.count ?? 0),
  })}\n`);
} finally {
  client.close();
}
