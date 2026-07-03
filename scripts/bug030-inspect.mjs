import { createClient } from '@libsql/client';
import fs from 'fs';
const c = createClient({ url: 'file:data/edgefinder.db' });
// auto-discovery state structure
try {
  const ad = JSON.parse(fs.readFileSync('data/auto-discovery-state.json', 'utf-8'));
  console.log('AD keys:', Object.keys(ad));
  const findTitles = (o, depth=0) => {
    if (depth > 3 || !o || typeof o !== 'object') return null;
    if (Array.isArray(o)) return o.length ? o[0] : null;
    return o;
  };
  for (const k of Object.keys(ad)) {
    const v = ad[k];
    if (Array.isArray(v) && v.length) console.log(k, 'array sample:', JSON.stringify(v[0]).slice(0, 300));
  }
} catch (e) { console.log('AD err', e.message); }
const r = await c.execute("SELECT raw_result FROM scan_results WHERE market_id='1782653182931-ph1guj' AND raw_result IS NOT NULL ORDER BY scanned_at DESC LIMIT 1");
const raw = r.rows[0]?.raw_result;
if (raw) { const p = JSON.parse(raw); console.log('raw keys:', Object.keys(p)); console.log(JSON.stringify(p).slice(0, 500)); }
else console.log('no raw_result');
