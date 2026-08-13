import path from 'path';
import { createClient, type Client, type Transaction } from '@libsql/client';

const SQLITE_PATH = process.env.H2H_SQLITE_PATH || path.join(process.cwd(), 'data', 'edgefinder.db');
let client: Client | null = null;
let initialized = false;

export type CouplingExecutor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;

export interface CouplingDependency {
  couplingKey: string;
  couplingRevision: number;
  kalshiTicker: string;
  pmConditionId: string;
}

export interface CouplingSnapshot extends CouplingDependency {
  state: 'active_auto' | 'active_manual' | 'deleted';
}

export interface CanonicalManualMatch {
  id: string;
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle: string;
  pmTitle: string;
  kalshiUrl?: string;
  polymarketUrl?: string;
  marketId?: string;
  createdAt: string;
}

function getClient(): Client {
  if (!client) {
    client = createClient({ url: `file:${SQLITE_PATH}` });
    void client.execute('PRAGMA busy_timeout = 5000').catch(() => {});
    void client.execute('PRAGMA journal_mode = WAL').catch(() => {});
  }
  return client;
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

export async function ensureCouplingStore(executor: CouplingExecutor = getClient()): Promise<void> {
  if (executor === getClient() && initialized) return;
  await executor.execute(`CREATE TABLE IF NOT EXISTS coupling_states (
    coupling_key TEXT PRIMARY KEY,
    kalshi_ticker TEXT NOT NULL,
    pm_condition_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active_auto','active_manual','deleted')),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    source TEXT NOT NULL,
    market_id TEXT,
    artist TEXT NOT NULL DEFAULT '',
    manual_match_id TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(kalshi_ticker, pm_condition_id)
  )`);
  await executor.execute('CREATE INDEX IF NOT EXISTS idx_coupling_states_manual_match ON coupling_states(manual_match_id)');
  await executor.execute(`CREATE TABLE IF NOT EXISTS manual_matches (
    id TEXT PRIMARY KEY,
    kalshi_ticker TEXT NOT NULL,
    pm_condition_id TEXT NOT NULL,
    kalshi_title TEXT NOT NULL,
    pm_title TEXT NOT NULL,
    kalshi_url TEXT,
    polymarket_url TEXT,
    market_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(kalshi_ticker, pm_condition_id)
  )`);
  if (executor === getClient()) initialized = true;
}

function snapshot(row: Record<string, unknown>): CouplingSnapshot {
  return {
    couplingKey: String(row.coupling_key),
    couplingRevision: Number(row.revision),
    kalshiTicker: String(row.kalshi_ticker),
    pmConditionId: String(row.pm_condition_id),
    state: String(row.state) as CouplingSnapshot['state'],
  };
}

export async function areCouplingDependenciesEligible(
  dependencies: readonly CouplingDependency[],
  executor: CouplingExecutor,
): Promise<boolean> {
  if (dependencies.length === 0) return false;
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    if (seen.has(dependency.couplingKey)) return false;
    seen.add(dependency.couplingKey);
    const normalized = normalizeCouplingIdentity(dependency.kalshiTicker, dependency.pmConditionId);
    if (dependency.couplingKey !== couplingKey(normalized.kalshiTicker, normalized.pmConditionId)
      || dependency.kalshiTicker !== normalized.kalshiTicker
      || dependency.pmConditionId !== normalized.pmConditionId
      || !Number.isSafeInteger(dependency.couplingRevision)) return false;
    const result = await executor.execute({
      sql: `SELECT state, revision FROM coupling_states WHERE coupling_key = ?`,
      args: [dependency.couplingKey],
    });
    if (!result.rows[0] || result.rows[0].state === 'deleted'
      || Number(result.rows[0].revision) !== dependency.couplingRevision) return false;
  }
  return true;
}

export async function captureCouplingDependencies(
  tuples: readonly { kalshiTicker?: string | null; pmConditionId?: string | null }[],
  source: string,
): Promise<CouplingDependency[]> {
  await ensureCouplingStore();
  const tx = await getClient().transaction('write');
  try {
    const dependencies = await captureCouplingDependenciesWithExecutor(tuples, source, tx);
    if (tuples.length > 0 && dependencies.length === 0) {
      await tx.rollback();
      return [];
    }
    await tx.commit();
    return dependencies;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

export async function captureCouplingDependenciesWithExecutor(
  tuples: readonly { kalshiTicker?: string | null; pmConditionId?: string | null }[],
  source: string,
  executor: CouplingExecutor,
): Promise<CouplingDependency[]> {
  await ensureCouplingStore(executor);
  const dependencies: CouplingDependency[] = [];
  const seen = new Set<string>();
  for (const tuple of tuples) {
    if (!tuple.kalshiTicker || !tuple.pmConditionId) return [];
    const normalized = normalizeCouplingIdentity(tuple.kalshiTicker, tuple.pmConditionId);
    const key = couplingKey(normalized.kalshiTicker, normalized.pmConditionId);
    if (seen.has(key)) continue;
    seen.add(key);
    await executor.execute({
      sql: `INSERT OR IGNORE INTO coupling_states
        (coupling_key, kalshi_ticker, pm_condition_id, state, revision, source, updated_at)
        VALUES (?, ?, ?, 'active_auto', 1, ?, ?)`,
      args: [key, normalized.kalshiTicker, normalized.pmConditionId, source, new Date().toISOString()],
    });
    const current = await executor.execute({ sql: 'SELECT * FROM coupling_states WHERE coupling_key = ?', args: [key] });
    if (!current.rows[0] || current.rows[0].state === 'deleted') return [];
    dependencies.push(snapshot(current.rows[0] as Record<string, unknown>));
  }
  return dependencies;
}

function pairExpression(field: 'last_scan_result' | 'live_result'): string {
  return `EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(${field}, '$.matchedPairs'), '[]')) p
    WHERE UPPER(json_extract(p.value, '$.kalshiTicker')) = ?
      AND LOWER(json_extract(p.value, '$.pmConditionId')) = ?)`;
}

async function updateSummaryForMutation(
  executor: CouplingExecutor,
  marketId: string | undefined,
  normalized: { kalshiTicker: string; pmConditionId: string },
  artist: string,
  deleting: boolean,
  dependency: CouplingDependency,
): Promise<void> {
  const targets = marketId
    ? await executor.execute({
        sql: `SELECT id, last_scan_result, live_result,
          scan_publication_generation, live_publication_generation
          FROM saved_markets WHERE id = ?`, args: [marketId],
      })
    : await executor.execute({
        sql: `SELECT id, last_scan_result, live_result,
          scan_publication_generation, live_publication_generation FROM saved_markets
          WHERE ${pairExpression('last_scan_result')} OR ${pairExpression('live_result')}`,
        args: [normalized.kalshiTicker, normalized.pmConditionId, normalized.kalshiTicker, normalized.pmConditionId],
      });
  for (const row of targets.rows as Record<string, unknown>[]) {
    for (const field of ['last_scan_result', 'live_result'] as const) {
      if (!row[field]) continue;
      let result: Record<string, unknown>;
      try { result = JSON.parse(String(row[field])); } catch { continue; }
      const existing = Array.isArray(result.matchedPairs) ? result.matchedPairs as Array<Record<string, unknown>> : [];
      const isPair = (pair: Record<string, unknown>) =>
        String(pair.kalshiTicker || '').toUpperCase() === normalized.kalshiTicker
        && String(pair.pmConditionId || '').toLowerCase() === normalized.pmConditionId;
      const pairs = deleting
        ? existing.filter((pair) => !isPair(pair))
        : existing.some(isPair) ? existing : [...existing, {
            artist: artist || normalized.kalshiTicker,
            kalshiTicker: normalized.kalshiTicker,
            pmConditionId: normalized.pmConditionId,
          }];
      result.matchedPairs = pairs;
      const existingDependencies = Array.isArray(result.matchDependencies)
        ? result.matchDependencies as CouplingDependency[] : [];
      result.matchDependencies = deleting
        ? existingDependencies.filter((item) => item.couplingKey !== dependency.couplingKey)
        : [...existingDependencies.filter((item) => item.couplingKey !== dependency.couplingKey), dependency];
      result.matchedCount = pairs.length;
      result.matchStatus = pairs.length > 0 ? 'matched' : 'confirmed_zero';
      result.matchError = null;
      result.scannedAt = new Date().toISOString();
      const generationColumn = field === 'last_scan_result'
        ? 'scan_publication_generation' : 'live_publication_generation';
      const generation = Number(row[generationColumn] ?? 0) + 1;
      result.publicationGeneration = generation;
      await executor.execute({
        sql: `UPDATE saved_markets SET ${field} = ?, ${generationColumn} = ? WHERE id = ?`,
        args: [JSON.stringify(result), generation, String(row.id)],
      });
    }
  }
}

export async function mutateManualCoupling(input: {
  action: 'create' | 'delete';
  marketId?: string;
  manualMatchId: string;
  kalshiTicker: string;
  pmConditionId: string;
  artist?: string;
  manualMatch?: CanonicalManualMatch;
}): Promise<CouplingSnapshot> {
  await ensureCouplingStore();
  const normalized = normalizeCouplingIdentity(input.kalshiTicker, input.pmConditionId);
  const key = couplingKey(normalized.kalshiTicker, normalized.pmConditionId);
  const tx = await getClient().transaction('write');
  try {
    const current = await tx.execute({ sql: 'SELECT * FROM coupling_states WHERE coupling_key = ?', args: [key] });
    const row = current.rows[0] as Record<string, unknown> | undefined;
    const desiredState = input.action === 'create' ? 'active_manual' : 'deleted';
    const revision = row && row.state !== desiredState ? Number(row.revision) + 1 : Number(row?.revision ?? 1);
    await tx.execute({
      sql: `INSERT INTO coupling_states
        (coupling_key, kalshi_ticker, pm_condition_id, state, revision, source, market_id, artist, manual_match_id, updated_at)
        VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)
        ON CONFLICT(coupling_key) DO UPDATE SET state=excluded.state, revision=excluded.revision,
          source='manual', market_id=COALESCE(excluded.market_id, coupling_states.market_id),
          artist=excluded.artist, manual_match_id=excluded.manual_match_id, updated_at=excluded.updated_at`,
      args: [key, normalized.kalshiTicker, normalized.pmConditionId, desiredState, revision,
        input.marketId ?? null, input.artist ?? '', input.manualMatchId, new Date().toISOString()],
    });
    const updated = await tx.execute({ sql: 'SELECT * FROM coupling_states WHERE coupling_key = ?', args: [key] });
    const dependency = snapshot(updated.rows[0] as Record<string, unknown>);
    if (input.action === 'create') {
      if (!input.manualMatch) throw new Error('Manual match record is required for create');
      const match = input.manualMatch;
      await tx.execute({
        sql: `INSERT INTO manual_matches
          (id, kalshi_ticker, pm_condition_id, kalshi_title, pm_title, kalshi_url, polymarket_url, market_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [match.id, normalized.kalshiTicker, normalized.pmConditionId, match.kalshiTitle, match.pmTitle,
          match.kalshiUrl ?? null, match.polymarketUrl ?? null, match.marketId ?? null, match.createdAt],
      });
    } else {
      await tx.execute({ sql: 'DELETE FROM manual_matches WHERE id = ?', args: [input.manualMatchId] });
    }
    await updateSummaryForMutation(tx, input.marketId, normalized, input.artist ?? '', input.action === 'delete', dependency);
    await tx.commit();
    return dependency;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

export async function getCanonicalManualMatches(): Promise<CanonicalManualMatch[]> {
  await ensureCouplingStore();
  const rows = await getClient().execute('SELECT * FROM manual_matches ORDER BY created_at');
  return rows.rows.map((row) => ({
    id: String(row.id), kalshiTicker: String(row.kalshi_ticker), pmConditionId: String(row.pm_condition_id),
    kalshiTitle: String(row.kalshi_title), pmTitle: String(row.pm_title),
    ...(row.kalshi_url ? { kalshiUrl: String(row.kalshi_url) } : {}),
    ...(row.polymarket_url ? { polymarketUrl: String(row.polymarket_url) } : {}),
    ...(row.market_id ? { marketId: String(row.market_id) } : {}), createdAt: String(row.created_at),
  }));
}

export async function hasManualCouplingHistory(): Promise<boolean> {
  await ensureCouplingStore();
  const result = await getClient().execute("SELECT 1 FROM coupling_states WHERE source = 'manual' LIMIT 1");
  return result.rows.length > 0;
}

export async function importActiveLegacyManualMatches(matches: readonly CanonicalManualMatch[]): Promise<void> {
  await ensureCouplingStore();
  const tx = await getClient().transaction('write');
  try {
    for (const match of matches) {
      const normalized = normalizeCouplingIdentity(match.kalshiTicker, match.pmConditionId);
      const state = await tx.execute({
        sql: 'SELECT state, manual_match_id FROM coupling_states WHERE coupling_key = ?',
        args: [couplingKey(normalized.kalshiTicker, normalized.pmConditionId)],
      });
      if (state.rows[0]?.state !== 'active_manual' || String(state.rows[0].manual_match_id) !== match.id) continue;
      await tx.execute({
        sql: `INSERT OR IGNORE INTO manual_matches
          (id, kalshi_ticker, pm_condition_id, kalshi_title, pm_title, kalshi_url, polymarket_url, market_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [match.id, normalized.kalshiTicker, normalized.pmConditionId, match.kalshiTitle, match.pmTitle,
          match.kalshiUrl ?? null, match.polymarketUrl ?? null, match.marketId ?? null, match.createdAt],
      });
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

export async function getDeletedCouplingKeys(executor: CouplingExecutor = getClient()): Promise<Set<string>> {
  await ensureCouplingStore(executor);
  const rows = await executor.execute(`SELECT coupling_key FROM coupling_states WHERE state = 'deleted'`);
  return new Set(rows.rows.map((row) => String(row.coupling_key)));
}
