// BUG-030: one-time backfill of scan_results.market_title
import { createClient } from '@libsql/client';
import fs from 'fs';

const c = createClient({ url: 'file:data/edgefinder.db' });
const saved = JSON.parse(fs.readFileSync('data/saved-markets.json', 'utf-8'));
const nameMap = new Map(saved.map(m => [m.id, m.eventTitle]));

// 1) Backfill from saved-markets (bulk per market_id)
let fromSaved = 0;
for (const [id, title] of nameMap) {
  if (!title) continue;
  const r = await c.execute({
    sql: 'UPDATE scan_results SET market_title = ? WHERE market_id = ? AND market_title IS NULL',
    args: [title, id],
  });
  fromSaved += r.rowsAffected;
}
console.log('backfilled from saved-markets:', fromSaved);

// 2) Orphans: try raw_result JSON for a title
const orphanRows = await c.execute(
  "SELECT DISTINCT market_id FROM scan_results WHERE market_title IS NULL"
);
let fromRaw = 0, unresolved = 0;
for (const row of orphanRows.rows) {
  const id = row.market_id;
  const rr = await c.execute({
    sql: "SELECT raw_result FROM scan_results WHERE market_id = ? AND raw_result IS NOT NULL ORDER BY scanned_at DESC LIMIT 1",
    args: [id],
  });
  let title = null;
  const raw = rr.rows[0]?.raw_result;
  if (raw) {
    try {
      const p = JSON.parse(raw);
      title = p.eventTitle || p.marketTitle || p.title || p.event?.title || null;
    } catch {}
  }
  if (title) {
    const u = await c.execute({
      sql: 'UPDATE scan_results SET market_title = ? WHERE market_id = ? AND market_title IS NULL',
      args: [title, id],
    });
    fromRaw += u.rowsAffected;
  } else unresolved++;
}
console.log('backfilled from raw_result:', fromRaw, '| unresolved market_ids:', unresolved);
const left = await c.execute('SELECT COUNT(*) n FROM scan_results WHERE market_title IS NULL');
console.log('rows still NULL:', left.rows[0].n);
