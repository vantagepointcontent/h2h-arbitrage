import { createClient } from '@libsql/client';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'data', 'edgefinder.db');
const c = createClient({ url: `file:${dbPath}` });

async function run() {
  await c.execute('PRAGMA busy_timeout = 5000');
  const indexes = await c.execute("SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE '%scan_results%'");
  console.log('scan_results indexes:', indexes.rows.map((r) => r.name));
  const rank = await c.execute("SELECT rank FROM scan_results_search LIMIT 1");
  console.log('FTS rank sample:', rank.rows);
  const explain = await c.execute('EXPLAIN QUERY PLAN SELECT id FROM scan_results ORDER BY scanned_at DESC, id DESC LIMIT 5');
  console.log('explain:', explain.rows.map((r) => r.detail));
  const rows = await c.execute('SELECT id, scanned_at FROM scan_results ORDER BY scanned_at DESC, id DESC LIMIT 5');
  console.log('latest rows:', rows.rows);
  await c.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
