import { createClient } from '@libsql/client';
import path from 'path';
import { scanRetentionDeleteSql, boundedZeroArbRetentionDays } from '../src/lib/scan-retention.mjs';

const DB_PATH = process.env.H2H_SQLITE_PATH
  || path.join(process.cwd(), 'data', 'edgefinder.db');
const CHECKPOINT_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.H2H_CHECKPOINT_INTERVAL_MS || 300_000),
);
const RETENTION_DAYS = Math.max(
  7,
  boundedZeroArbRetentionDays(process.env.H2H_PRUNE_RETENTION_DAYS || 7),
);
const PRUNE_HOUR = Number(process.env.H2H_PRUNE_HOUR_UTC || '5');

function log(msg) {
  console.log(`[h2h-db-maintenance] ${msg}`);
}

async function checkpoint(db, mode) {
  const before = Date.now();
  const result = await db.execute(`PRAGMA wal_checkpoint(${mode})`);
  const elapsed = Date.now() - before;
  const row = result.rows[0];
  log(`checkpoint(${mode}) done in ${elapsed}ms: busy=${row.busy} log=${row.log} checkpointed=${row.checkpointed}`);
  return row;
}

async function boundedCheckpoint(db) {
  // PASSIVE never waits for readers or takes the exclusive lock that a hot
  // TRUNCATE checkpoint needs. Only attempt truncation after PASSIVE proves the
  // complete logical WAL is already checkpointed; a race is observed on the
  // next interval rather than crash-looping under PM2 every five seconds.
  const row = await checkpoint(db, 'PASSIVE');
  if (Number(row.busy) === 0 && Number(row.log) > 0 && Number(row.log) === Number(row.checkpointed)) {
    await checkpoint(db, 'TRUNCATE');
  }
}

async function prune(db) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const before = await db.execute('SELECT COUNT(*) AS cnt FROM scan_results');
  const beforeCount = Number(before.rows[0].cnt);
  const result = await db.execute(scanRetentionDeleteSql, [cutoff]);
  const deleted = Number(result.rowsAffected ?? 0);
  const after = await db.execute('SELECT COUNT(*) AS cnt FROM scan_results');
  const afterCount = Number(after.rows[0].cnt);
  log(`pruned ${deleted} zero-arbitrage scan_results older than ${RETENTION_DAYS} days (${beforeCount} -> ${afterCount})`);
  return deleted;
}

async function runMaintenance() {
  const db = createClient({ url: `file:${DB_PATH}` });
  try {
    await db.execute('PRAGMA busy_timeout = 5000');
    await db.execute('PRAGMA journal_mode = WAL');
    await db.execute('PRAGMA synchronous = NORMAL');
    await db.execute('PRAGMA wal_autocheckpoint = 1000');

    let nextPruneDate = '';
    while (true) {
      await boundedCheckpoint(db);

      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (today !== nextPruneDate && now.getUTCHours() === PRUNE_HOUR) {
        nextPruneDate = today;
        try {
          await prune(db);
        } catch (e) {
          log(`prune failed: ${e.message}`);
        }
      }

      await new Promise(r => setTimeout(r, CHECKPOINT_INTERVAL_MS));
    }
  } finally {
    db.close();
  }
}

runMaintenance().catch(e => {
  console.error('[h2h-db-maintenance] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
