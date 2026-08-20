import { createClient } from '@libsql/client';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'data', 'edgefinder.db');
const c = createClient({ url: `file:${dbPath}` });

async function run() {
  await c.execute('PRAGMA busy_timeout = 5000');
  const totals = await c.execute('SELECT COUNT(*) as cnt FROM scan_results');
  const completed = await c.execute("SELECT COUNT(*) as cnt FROM scan_results WHERE scan_status='completed'");
  const pos = await c.execute("SELECT COUNT(*) as cnt FROM scan_results WHERE scan_status='completed' AND positive_arb_count>0");
  const zero = await c.execute("SELECT COUNT(*) as cnt FROM scan_results WHERE scan_status='completed' AND positive_arb_count=0");
  const invalid = await c.execute("SELECT COUNT(*) as cnt FROM scan_results WHERE scan_status='completed' AND arb_valid=0");
  const minMax = await c.execute('SELECT MIN(id) as minId, MAX(id) as maxId, MIN(scanned_at) as minAt, MAX(scanned_at) as maxAt FROM scan_results');
  const recent = await c.execute("SELECT COUNT(*) as cnt FROM scan_results WHERE scanned_at > datetime('now', '-7 days')");
  console.log('totals', totals.rows[0]);
  console.log('completed', completed.rows[0]);
  console.log('positiveArb', pos.rows[0]);
  console.log('zeroArb', zero.rows[0]);
  console.log('invalid', invalid.rows[0]);
  console.log('minMax', minMax.rows[0]);
  console.log('recent7d', recent.rows[0]);
  await c.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
