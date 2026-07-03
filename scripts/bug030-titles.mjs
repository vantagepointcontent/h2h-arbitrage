import fs from 'fs';
const sources = ['data/saved-markets.json', 'data/saved-markets.json.bak', 'data/scan-history.json'];
const titles = new Map();
for (const f of sources) {
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const arr = Array.isArray(d) ? d : [];
    for (const e of arr) {
      const id = e.id || e.marketId;
      const t = e.eventTitle || e.marketTitle || e.title;
      if (id && t && !titles.has(id)) titles.set(id, t);
    }
    console.log(f, 'entries:', arr.length);
  } catch (e) { console.log(f, 'err', e.message); }
}
console.log('titles collected:', titles.size);
// how many of the 436 orphans covered?
import { createClient } from '@libsql/client';
const c = createClient({ url: 'file:data/edgefinder.db' });
const rows = await c.execute('SELECT DISTINCT market_id FROM scan_results');
let covered = 0, uncovered = 0;
const uncoveredIds = [];
for (const r of rows.rows) {
  if (titles.has(r.market_id)) covered++; else { uncovered++; uncoveredIds.push(r.market_id); }
}
console.log('distinct ids in db:', rows.rows.length, 'covered:', covered, 'uncovered:', uncovered);
console.log('sample uncovered:', uncoveredIds.slice(0, 5));
