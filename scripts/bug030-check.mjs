import { createClient } from '@libsql/client';
import fs from 'fs';
const c = createClient({ url: 'file:data/edgefinder.db' });
const saved = JSON.parse(fs.readFileSync('data/saved-markets.json', 'utf-8'));
const ids = new Set(saved.map(m => m.id));
const rows = await c.execute('SELECT market_id, COUNT(*) n, MAX(scanned_at) last FROM scan_results GROUP BY market_id');
let orphans = 0;
for (const r of rows.rows) {
  if (!ids.has(r.market_id)) { orphans++; console.log('ORPHAN', r.market_id, r.n, r.last); }
}
console.log('total distinct market_ids:', rows.rows.length, 'orphans:', orphans);
const mt = await c.execute("SELECT COUNT(*) t, SUM(market_title IS NULL) nulls FROM scan_results");
console.log('rows:', JSON.stringify(mt.rows[0]));
