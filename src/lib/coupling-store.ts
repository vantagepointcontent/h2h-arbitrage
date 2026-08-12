import path from 'path';
import { promises as fs } from 'fs';
import { createClient, type Client, type Transaction } from '@libsql/client';

const SQLITE_PATH = path.join(process.cwd(), 'data', 'edgefinder.db');
let client: Client | null = null;
let initialized = false;

type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;

function getClient(): Client {
  if (!client) {
    client = createClient({ url: `file:${SQLITE_PATH}` });
    void client.execute('PRAGMA busy_timeout = 5000').catch(() => {});
    void client.execute('PRAGMA journal_mode = WAL').catch(() => {});
  }
  return client;
}

export interface CouplingTombstone {
  id: string;
  couplingKey: string;
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle: string;
  pmTitle: string;
  decoupledAt: string;
  manualMatchId?: string;
  revision: number;
}

export function normalizeCouplingIdentity(kalshiTicker: string, pmConditionId: string) {
  return {
    kalshiTicker: kalshiTicker.trim().toUpperCase(),
    pmConditionId: pmConditionId.trim().toLowerCase(),
  };
}

export function couplingKey(kalshiTicker: string, pmConditionId: string): string {
  const normalized = normalizeCouplingIdentity(kalshiTicker, pmConditionId);
  return `v1:kalshi:${normalized.kalshiTicker}|polymarket:${normalized.pmConditionId}`;
}

export async function ensureCouplingStore(): Promise<void> {
  if (initialized) return;
  const c = getClient();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS coupling_states (
      coupling_key TEXT PRIMARY KEY,
      kalshi_ticker TEXT NOT NULL,
      pm_condition_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active_manual', 'deleted')),
      source TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      kalshi_title TEXT NOT NULL DEFAULT '',
      pm_title TEXT NOT NULL DEFAULT '',
      manual_match_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await c.execute('CREATE INDEX IF NOT EXISTS idx_coupling_states_state ON coupling_states(state)');
  await c.execute('CREATE INDEX IF NOT EXISTS idx_coupling_states_manual_id ON coupling_states(manual_match_id)');
  // One-time compatibility migration. SQLite is authoritative after import.
  const count = await c.execute('SELECT COUNT(*) AS count FROM coupling_states');
  if (Number(count.rows[0]?.count ?? 0) === 0) {
    try {
      const legacy = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'decoupled-pairs.json'), 'utf8'));
      for (const pair of Array.isArray(legacy) ? legacy : []) {
        if (!pair?.kalshiTicker || !pair?.pmConditionId) continue;
        const normalized = normalizeCouplingIdentity(String(pair.kalshiTicker), String(pair.pmConditionId));
        const key = couplingKey(normalized.kalshiTicker, normalized.pmConditionId);
        const deletedAt = String(pair.decoupledAt || new Date().toISOString());
        await c.execute({
          sql: `INSERT OR IGNORE INTO coupling_states
            (coupling_key, kalshi_ticker, pm_condition_id, state, source, revision,
             kalshi_title, pm_title, manual_match_id, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, 'deleted', 'legacy_migration', 1, ?, ?, ?, ?, ?, ?)`,
          args: [key, normalized.kalshiTicker, normalized.pmConditionId, String(pair.kalshiTitle || ''), String(pair.pmTitle || ''), pair.manualMatchId ? String(pair.manualMatchId) : null, deletedAt, deletedAt, deletedAt],
        });
      }
    } catch { /* no legacy store is a valid fresh install */ }
  }
  initialized = true;
}

function rowToTombstone(row: Record<string, unknown>): CouplingTombstone {
  return {
    id: String(row.coupling_key),
    couplingKey: String(row.coupling_key),
    kalshiTicker: String(row.kalshi_ticker),
    pmConditionId: String(row.pm_condition_id),
    kalshiTitle: String(row.kalshi_title || ''),
    pmTitle: String(row.pm_title || ''),
    decoupledAt: String(row.deleted_at || row.updated_at),
    manualMatchId: row.manual_match_id ? String(row.manual_match_id) : undefined,
    revision: Number(row.revision),
  };
}

export async function getDeletedCouplings(executor?: Executor): Promise<CouplingTombstone[]> {
  if (!executor) await ensureCouplingStore();
  const result = await (executor ?? getClient()).execute(`
    SELECT * FROM coupling_states WHERE state = 'deleted' ORDER BY deleted_at ASC
  `);
  return result.rows.map((row) => rowToTombstone(row as Record<string, unknown>));
}

export interface DeleteCouplingInput {
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle?: string;
  pmTitle?: string;
  manualMatchId?: string;
}

/** Canonical, idempotent deletion. Tombstone + current derivative invalidation commit together. */
export async function deleteCoupling(input: DeleteCouplingInput): Promise<CouplingTombstone> {
  await ensureCouplingStore();
  const c = getClient();
  const normalized = normalizeCouplingIdentity(input.kalshiTicker, input.pmConditionId);
  const key = couplingKey(normalized.kalshiTicker, normalized.pmConditionId);
  const tx = await c.transaction('write');
  try {
    const existing = await tx.execute({ sql: 'SELECT * FROM coupling_states WHERE coupling_key = ?', args: [key] });
    if (existing.rows[0]?.state === 'deleted') {
      await tx.commit();
      return rowToTombstone(existing.rows[0] as Record<string, unknown>);
    }
    const now = new Date().toISOString();
    await tx.execute({
      sql: `INSERT INTO coupling_states
        (coupling_key, kalshi_ticker, pm_condition_id, state, source, revision,
         kalshi_title, pm_title, manual_match_id, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, 'deleted', 'user_delete', 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(coupling_key) DO UPDATE SET
          state = 'deleted', source = 'user_delete', revision = coupling_states.revision + 1,
          kalshi_title = excluded.kalshi_title, pm_title = excluded.pm_title,
          manual_match_id = COALESCE(excluded.manual_match_id, coupling_states.manual_match_id),
          updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
      args: [key, normalized.kalshiTicker, normalized.pmConditionId, input.kalshiTitle ?? '', input.pmTitle ?? '', input.manualMatchId ?? null, now, now, now],
    });

    // Invalidate only saved markets containing this exact stable venue tuple.
    const markets = await tx.execute('SELECT id, last_scan_result, live_result FROM saved_markets');
    const affected = new Set<string>();
    for (const row of markets.rows as Record<string, unknown>[]) {
      for (const field of ['last_scan_result', 'live_result']) {
        if (!row[field]) continue;
        try {
          const parsed = JSON.parse(String(row[field]));
          if ((parsed.allArbs || []).some((arb: Record<string, unknown>) =>
            arb.kalshiTicker && arb.pmConditionId && couplingKey(String(arb.kalshiTicker), String(arb.pmConditionId)) === key)) {
            affected.add(String(row.id));
          }
        } catch { /* malformed derived cache cannot identify a coupling */ }
      }
    }
    try {
      const targets = await tx.execute({
        sql: 'SELECT DISTINCT pair_id FROM watch_targets WHERE UPPER(kalshi_ticker) = ? AND LOWER(pm_condition_id) = ?',
        args: [normalized.kalshiTicker, normalized.pmConditionId],
      });
      for (const row of targets.rows) affected.add(String(row.pair_id));
      await tx.execute({
        sql: 'DELETE FROM watch_targets WHERE UPPER(kalshi_ticker) = ? AND LOWER(pm_condition_id) = ?',
        args: [normalized.kalshiTicker, normalized.pmConditionId],
      });
    } catch { /* watcher tables are optional before watcher initialization */ }
    for (const marketId of affected) {
      await tx.execute({
        sql: 'UPDATE saved_markets SET last_scan_result = NULL, live_result = NULL WHERE id = ?',
        args: [marketId],
      });
    }
    await tx.commit();
    const { notifyCouplingDerivedInvalidation } = await import('./persistence');
    notifyCouplingDerivedInvalidation();
    const result = await c.execute({ sql: 'SELECT * FROM coupling_states WHERE coupling_key = ?', args: [key] });
    return rowToTombstone(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

/** Explicit user create/restore is the only operation that clears deleted state. */
export async function restoreCoupling(kalshiTicker: string, pmConditionId: string): Promise<void> {
  await ensureCouplingStore();
  const key = couplingKey(kalshiTicker, pmConditionId);
  const now = new Date().toISOString();
  await getClient().execute({
    sql: `UPDATE coupling_states SET state = 'active_manual', source = 'user_restore',
          revision = revision + 1, updated_at = ?, deleted_at = NULL WHERE coupling_key = ?`,
    args: [now, key],
  });
}

export async function removeTombstoneById(id: string): Promise<boolean> {
  await ensureCouplingStore();
  const existing = await getClient().execute({ sql: `SELECT coupling_key FROM coupling_states WHERE coupling_key = ? AND state = 'deleted'`, args: [id] });
  if (!existing.rows.length) return false;
  await restoreCoupling(String(existing.rows[0].coupling_key).split('|')[0].replace('v1:kalshi:', ''), String(existing.rows[0].coupling_key).split('polymarket:')[1]);
  return true;
}

export async function wasDeletedByManualMatchId(id: string): Promise<boolean> {
  await ensureCouplingStore();
  const result = await getClient().execute({
    sql: `SELECT 1 FROM coupling_states WHERE manual_match_id = ? AND state = 'deleted' LIMIT 1`, args: [id],
  });
  return result.rows.length > 0;
}
