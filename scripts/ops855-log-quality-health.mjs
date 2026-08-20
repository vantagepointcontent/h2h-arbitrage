import { createClient } from '@libsql/client';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(process.cwd(), 'data', 'edgefinder.db');

async function ensureLogsDataQualitySchema(c) {
  await c.execute(`CREATE TABLE IF NOT EXISTS logs_data_quality_batches (
    scan_id INTEGER PRIMARY KEY,
    observed_at TEXT NOT NULL,
    state TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    reconciliation_attempts INTEGER NOT NULL DEFAULT 0
  )`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_logs_data_quality_observed ON logs_data_quality_batches(observed_at DESC, scan_id DESC)`);
  await c.execute(`CREATE TABLE IF NOT EXISTS logs_data_quality_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  )`);
}

async function run() {
  const c = createClient({ url: `file:${dbPath}` });
  await c.execute('PRAGMA busy_timeout = 5000');
  await ensureLogsDataQualitySchema(c);
  const rows = await c.execute('SELECT state, snapshot_json FROM logs_data_quality_batches ORDER BY observed_at DESC, scan_id DESC LIMIT 500');
  const snapshots = rows.rows.flatMap((row) => { try { return [JSON.parse(String(row.snapshot_json))]; } catch { return []; } });
  const fields = {};
  const required = ['roi', 'profit', 'apy', 'state', 'currentRoi'];
  for (const field of required) {
    const denominator = snapshots.reduce((sum, s) => sum + (s.fields[field]?.denominator ?? 0), 0);
    const unavailable = snapshots.reduce((sum, s) => sum + (s.fields[field]?.unavailable ?? 0), 0);
    fields[field] = { denominator, unavailable, unavailablePct: denominator === 0 ? 0 : unavailable * 100 / denominator };
  }
  console.log('rolling batches:', snapshots.length, 'degraded:', snapshots.filter((s) => s.state === 'degraded').length);
  for (const [field, m] of Object.entries(fields)) {
    console.log(`  ${field}: ${m.denominator - m.unavailable}/${m.denominator} unavailable ${m.unavailablePct?.toFixed?.(2) ?? m.unavailablePct}%`);
  }
  if (snapshots[0]) {
    console.log('latest state:', snapshots[0].state, 'breaches:', snapshots[0].breaches.length);
  }
  await c.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
