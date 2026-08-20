import { createClient } from '@libsql/client';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'data', 'edgefinder.db');
const c = createClient({ url: `file:${dbPath}` });

async function run() {
  await c.execute('PRAGMA busy_timeout = 5000');
  const tables = await c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='proposition_relationships'");
  if (tables.rows.length === 0) {
    console.log('proposition_relationships table does not exist; registry is JSON-backed.');
    await c.close();
    return;
  }
  const count = await c.execute('SELECT COUNT(*) as cnt FROM proposition_relationships');
  console.log('db relationship rows', count.rows[0].cnt);
  await c.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
