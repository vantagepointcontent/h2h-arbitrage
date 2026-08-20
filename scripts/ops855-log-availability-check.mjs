import { createClient } from '@libsql/client';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'data', 'edgefinder.db');
const c = createClient({ url: `file:${dbPath}` });

async function run() {
  await c.execute('PRAGMA busy_timeout = 5000');
  const r = await c.execute(`SELECT COUNT(*) as total,
    SUM(CASE WHEN best_roi_pct IS NOT NULL AND best_roi_pct != 0 THEN 1 ELSE 0 END) as roi_ok,
    SUM(CASE WHEN best_profit IS NOT NULL AND best_profit != 0 THEN 1 ELSE 0 END) as profit_ok,
    SUM(CASE WHEN apy_pct IS NOT NULL AND apy_pct != 0 THEN 1 ELSE 0 END) as apy_ok,
    SUM(CASE WHEN scan_status IS NOT NULL THEN 1 ELSE 0 END) as state_ok
    FROM scan_results WHERE scan_status='completed' AND arb_valid=1 AND positive_arb_count>0`);
  console.log('completed positive arb rows:', r.rows[0]);
  const tables = await c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='logs_data_quality_batches'");
  if (tables.rows.length === 0) {
    console.log('logs_data_quality_batches table does not exist yet; new scans will create it.');
  } else {
    const q = await c.execute('SELECT state, COUNT(*) as cnt FROM logs_data_quality_batches GROUP BY state');
    console.log('data quality states:', q.rows);
    const latest = await c.execute('SELECT snapshot_json FROM logs_data_quality_batches ORDER BY observed_at DESC LIMIT 1');
    if (latest.rows[0]) {
      const snap = JSON.parse(String(latest.rows[0].snapshot_json));
      console.log('latest batch state:', snap.state, 'breaches:', snap.breaches.length);
      for (const [field, m] of Object.entries(snap.fields)) {
        console.log(`  ${field}: ${m.available}/${m.denominator} unavailable ${m.unavailablePct?.toFixed?.(2) ?? m.unavailablePct}%`);
      }
    }
  }
  await c.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
