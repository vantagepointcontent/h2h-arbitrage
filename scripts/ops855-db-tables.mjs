import { createClient } from '@libsql/client';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'data', 'edgefinder.db');
const c = createClient({ url: `file:${dbPath}` });

async function run() {
  await c.execute('PRAGMA busy_timeout = 5000');
  const tables = await c.execute("SELECT name FROM sqlite_master WHERE type='table'");
  console.log('tables:', tables.rows.map((r) => r.name));
  const scanCount = await c.execute('SELECT COUNT(*) as cnt FROM scan_results');
  console.log('scan_results rows:', scanCount.rows[0].cnt);
  const botEval = await c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_scan_evaluations'");
  console.log('bot_scan_evaluations exists:', botEval.rows.length > 0);
  if (botEval.rows.length > 0) {
    const evalCount = await c.execute('SELECT COUNT(*) as cnt FROM bot_scan_evaluations');
    console.log('bot_scan_evaluations rows:', evalCount.rows[0].cnt);
  }
  await c.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
