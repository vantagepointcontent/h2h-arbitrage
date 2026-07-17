/**
 * OPS-007: DB pruning script — removes scan_results older than N days.
 * Run daily via cron or pm2. Keeps DB size manageable.
 *
 * Usage: node scripts/prune-db.mjs [days]
 * Default: 30 days retention
 */
import { createClient } from '@libsql/client';

const DB_PATH = new URL('../data/edgefinder.db', import.meta.url).pathname;
const RETENTION_DAYS = parseInt(process.argv[2] || '30', 10);

async function main() {
  const db = createClient({ url: `file:${DB_PATH}` });
  
  // Count before
  const before = await db.execute('SELECT COUNT(*) as cnt FROM scan_results');
  console.log(`[prune] scan_results before: ${before.rows[0].cnt} rows`);
  
  // Delete old rows
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  console.log(`[prune] deleting rows older than ${RETENTION_DAYS} days (before ${cutoff})`);
  
  const result = await db.execute('DELETE FROM scan_results WHERE scanned_at < ?', [cutoff]);
  console.log(`[prune] deleted ${result.rowsAffected} rows`);
  
  // Vacuum to reclaim space
  console.log('[prune] vacuuming...');
  await db.execute('VACUUM');
  
  // Count after
  const after = await db.execute('SELECT COUNT(*) as cnt FROM scan_results');
  console.log(`[prune] scan_results after: ${after.rows[0].cnt} rows`);
  
  db.close();
  console.log('[prune] done');
}

main().catch(e => {
  console.error('[prune] error:', e.message);
  process.exit(1);
});