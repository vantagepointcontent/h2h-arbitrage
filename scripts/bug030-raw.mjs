import { createClient } from '@libsql/client';
const c = createClient({ url: 'file:data/edgefinder.db' });
const r = await c.execute("SELECT raw_result FROM scan_results WHERE market_id='1782653182846-dhiy5b' AND positive_arb_count>0 AND raw_result IS NOT NULL ORDER BY scanned_at DESC LIMIT 1");
const raw = r.rows[0]?.raw_result;
if (raw) { const p = JSON.parse(raw); console.log(JSON.stringify(p.allArbs?.[0], null, 1).slice(0, 1200)); }
else console.log('none');
