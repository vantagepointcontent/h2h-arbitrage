import { promises as fs } from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';

const DATA_FILE = path.join(process.cwd(), 'data', 'saved-markets.json');

// ── SQLite (libsql) ──────────────────────────────────────────────

const SQLITE_PATH = path.join(process.cwd(), 'data', 'edgefinder.db');
let _client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (!_client) {
    _client = createClient({ url: `file:${SQLITE_PATH}` });
  }
  return _client;
}

async function initDb(): Promise<void> {
  const c = getClient();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS scan_results (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id       TEXT    NOT NULL,
      best_roi_pct    REAL    NOT NULL DEFAULT 0,
      best_profit     REAL    NOT NULL DEFAULT 0,
      strategy        TEXT    NOT NULL DEFAULT '',
      outcome_count   INTEGER NOT NULL DEFAULT 0,
      matched_count   INTEGER NOT NULL DEFAULT 0,
      kalshi_count    INTEGER NOT NULL DEFAULT 0,
      pm_count        INTEGER NOT NULL DEFAULT 0,
      positive_arb_count INTEGER NOT NULL DEFAULT 0,
      total_stake     REAL    NOT NULL DEFAULT 0,
      scanned_at      TEXT    NOT NULL,
      raw_result      TEXT,   -- full JSON payload for later drill-down
      market_title    TEXT    -- human-readable market name (BUG-030: prevents raw IDs in Logs)
    )
  `);
  // Migration: add market_title column if missing (existing DBs)
  try {
    await c.execute(`ALTER TABLE scan_results ADD COLUMN market_title TEXT`);
  } catch { /* column already exists */ }
  // Index for fast per-market lookups
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_scan_results_market_id ON scan_results(market_id)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_scan_results_scanned_at ON scan_results(scanned_at DESC)`);

  // ── OPS-009: saved markets + scan history live in SQLite ──────────
  // JSON files had multi-process write races (app + poller). SQLite with
  // the app as single writer eliminates them; a JSON mirror is written
  // best-effort for the poller (read-only) and rollback safety.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS saved_markets (
      id               TEXT PRIMARY KEY,
      kalshi_url       TEXT NOT NULL,
      polymarket_url   TEXT NOT NULL,
      event_title      TEXT NOT NULL DEFAULT '',
      category         TEXT,
      created_at       TEXT NOT NULL,
      expiry_date      TEXT,
      favorite         INTEGER NOT NULL DEFAULT 0,
      last_scan_result TEXT    -- JSON LastScanResult
    )
  `);
  await c.execute(`
    CREATE TABLE IF NOT EXISTS scan_history (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_timestamp     TEXT NOT NULL,
      market_id          TEXT NOT NULL,
      total_profit       REAL NOT NULL DEFAULT 0,
      best_roi_pct       REAL NOT NULL DEFAULT 0,
      positive_arb_count INTEGER NOT NULL DEFAULT 0,
      matched_count      INTEGER NOT NULL DEFAULT 0
    )
  `);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_scan_history_ts ON scan_history(scan_timestamp DESC)`);
}

// Lazy-init: first call guarantees the table exists
let _dbInited = false;
async function ensureDb(): Promise<void> {
  if (_dbInited) return;
  await initDb();
  _dbInited = true;
}

/** Persist a scan result to SQLite. */
export async function saveScanResult(
  marketId: string,
  result: {
    bestRoiPct: number;
    bestProfit: number;
    strategy: string;
    outcomeCount: number;
    matchedCount: number;
    kalshiCount: number;
    pmCount: number;
    scannedAt: string;
    positiveArbCount?: number;
    totalStake?: number;
    raw?: unknown;
    marketTitle?: string;
  },
): Promise<{ id: number }> {
  await ensureDb();
  const c = getClient();
  const row = await c.execute({
    sql: `INSERT INTO scan_results
      (market_id, best_roi_pct, best_profit, strategy,
       outcome_count, matched_count, kalshi_count, pm_count,
       positive_arb_count, total_stake, scanned_at, raw_result, market_title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      marketId,
      result.bestRoiPct ?? 0,
      result.bestProfit ?? 0,
      result.strategy ?? '',
      result.outcomeCount ?? 0,
      result.matchedCount ?? 0,
      result.kalshiCount ?? 0,
      result.pmCount ?? 0,
      result.positiveArbCount ?? 0,
      result.totalStake ?? 0,
      result.scannedAt ?? new Date().toISOString(),
      typeof result.raw === 'string' ? result.raw : (result.raw ? JSON.stringify(result.raw) : null),
      result.marketTitle ?? null,
    ],
  });
  return { id: Number((row as any).insertId ?? row.lastInsertRowid ?? 0) };
}

/** Prune scan results older than `days` days. Returns number of rows deleted. */
export async function pruneOldScans(days: number = 30): Promise<number> {
  await ensureDb();
  const c = getClient();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const result = await c.execute({
    sql: 'DELETE FROM scan_results WHERE scanned_at < ?',
    args: [cutoff],
  });
  return Number((result as any).rowsAffected ?? 0);
}

/** Return total number of scan results in the DB. */
export async function getScanCount(): Promise<number> {
  await ensureDb();
  const c = getClient();
  const result = await c.execute('SELECT COUNT(*) AS cnt FROM scan_results');
  return (result.rows as any[])?.[0]?.cnt ?? 0;
}

/** Return scan history for a given market (newest first). */
export async function getScanHistory(marketId?: string, limit: number = 20): Promise<any[]> {
  await ensureDb();
  const c = getClient();
  const clampedLimit = Math.min(Math.max(limit, 1), 50000);

  let sql = 'SELECT * FROM scan_results WHERE 1=1';
  const args: (string | number)[] = [];

  if (marketId) {
    sql += ' AND market_id = ?';
    args.push(marketId);
  }
  sql += ' ORDER BY scanned_at DESC LIMIT ?';
  args.push(clampedLimit);

  const rows = await c.execute({ sql, args });
  return Array.isArray(rows.rows) ? rows.rows : [];
}

export interface LastScanResult {
  bestRoiPct: number;      // t.ex. 26.5 (for backward compat / display)
  bestProfit: number;       // t.ex. 265
  strategy: string;         // "Buy YES Kalshi + NO PM"
  outcomeCount: number;
  matchedCount: number;
  kalshiCount: number;
  pmCount: number;
  scannedAt: string;        // ISO timestamp
  allArbs?: {               // ALL positive arbitrage opportunities in this scan
    artist: string;
    roiPct: number;
    expectedProfit: number;
    strategy: string;
    fees?: {
      kalshiFee: number;
      pmFee: number;
      kalshiFeeDetails: string;
      pmFeeDetails: string;
      netProfitIfKalshiWins: number;
      netProfitIfPmWins: number;
      worstCaseNetProfit: number;
    };
  }[];
}

export interface SavedMarket {
  id: string;
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  category?: string; // e.g. "Politics", "Temperature", "Finances", "Mentions", "Sports"
  createdAt: string;
  expiryDate?: string | null; // ISO timestamp
  favorite?: boolean;         // user-starred for quick access
  lastScanResult?: LastScanResult | null;
}

async function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

// ── OPS-009: SQLite-backed saved markets ──────────────────────────
// The DB is the source of truth. A JSON mirror of saved-markets.json is
// written best-effort after each mutation so the poller (read-only) and
// any legacy tooling keep working, and so a rollback is one file-copy away.

function rowToMarket(r: any): SavedMarket {
  let lastScanResult: LastScanResult | null = null;
  try { lastScanResult = r.last_scan_result ? JSON.parse(String(r.last_scan_result)) : null; } catch {}
  return {
    id: String(r.id),
    kalshiUrl: String(r.kalshi_url),
    polymarketUrl: String(r.polymarket_url),
    eventTitle: String(r.event_title ?? ''),
    category: r.category != null ? String(r.category) : undefined,
    createdAt: String(r.created_at),
    expiryDate: r.expiry_date != null ? String(r.expiry_date) : null,
    favorite: Boolean(Number(r.favorite ?? 0)),
    lastScanResult,
  };
}

async function upsertMarketRow(m: SavedMarket): Promise<void> {
  const c = getClient();
  await c.execute({
    sql: `INSERT INTO saved_markets
            (id, kalshi_url, polymarket_url, event_title, category, created_at, expiry_date, favorite, last_scan_result)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kalshi_url = excluded.kalshi_url,
            polymarket_url = excluded.polymarket_url,
            event_title = excluded.event_title,
            category = excluded.category,
            expiry_date = excluded.expiry_date,
            favorite = excluded.favorite,
            last_scan_result = excluded.last_scan_result`,
    args: [
      m.id, m.kalshiUrl, m.polymarketUrl, m.eventTitle, m.category ?? null,
      m.createdAt, m.expiryDate ?? null, m.favorite ? 1 : 0,
      m.lastScanResult ? JSON.stringify(m.lastScanResult) : null,
    ],
  });
}

// One-time migration: import JSON file into SQLite if table is empty.
let _marketsMigrated = false;
async function ensureMarketsMigrated(): Promise<void> {
  if (_marketsMigrated) return;
  await ensureDb();
  const c = getClient();
  const cnt = await c.execute('SELECT COUNT(*) AS cnt FROM saved_markets');
  const rows = Number((cnt.rows as any[])[0]?.cnt ?? 0);
  if (rows === 0) {
    try {
      const data = await fs.readFile(DATA_FILE, 'utf-8');
      const parsed: SavedMarket[] = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        for (const m of parsed) await upsertMarketRow(m);
        console.log(`[OPS-009] Migrated ${parsed.length} saved markets from JSON to SQLite`);
      }
    } catch { /* no JSON file — fresh install */ }
  }
  _marketsMigrated = true;
}

/** Best-effort JSON mirror for the poller + rollback safety. Never throws. */
async function mirrorMarketsToJson(): Promise<void> {
  try {
    const markets = await getSavedMarkets();
    await ensureDir();
    const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(markets, null, 2));
    await fs.rename(tmp, DATA_FILE);
    try { await fs.copyFile(DATA_FILE, `${DATA_FILE}.bak`); } catch {}
  } catch (err) {
    console.warn('[OPS-009] JSON mirror write failed (DB unaffected):', err instanceof Error ? err.message : err);
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export async function getSavedMarkets(): Promise<SavedMarket[]> {
  await ensureMarketsMigrated();
  const c = getClient();
  const res = await c.execute('SELECT * FROM saved_markets ORDER BY created_at ASC');
  return (res.rows as any[]).map(rowToMarket);
}

/** Normalize a URL for identity comparison (strip trailing slash + query, lowercase) */
function normalizeUrl(url: string): string {
  return (url || '').split('?')[0].replace(/\/$/, '').toLowerCase();
}

export async function addSavedMarket(market: Omit<SavedMarket, 'id' | 'createdAt' | 'lastScanResult'>): Promise<SavedMarket> {
  const markets = await getSavedMarkets();
  const normK = normalizeUrl(market.kalshiUrl);
  const normP = normalizeUrl(market.polymarketUrl);
  // Check by URL first (more reliable than title)
  const urlExists = markets.some(m =>
    normalizeUrl(m.kalshiUrl) === normK || normalizeUrl(m.polymarketUrl) === normP
  );
  // Fall back to title check for legacy entries
  const nameExists = markets.some(m => m.eventTitle.toLowerCase().trim() === (market.eventTitle || 'Untitled').toLowerCase().trim());
  if (urlExists || nameExists) {
    throw new Error(`Market already exists: "${market.eventTitle || 'Untitled'}"`);
  }
  const newMarket: SavedMarket = {
    ...market,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
    lastScanResult: null,
  };
  await upsertMarketRow(newMarket);
  await mirrorMarketsToJson();
  return newMarket;
}

/** Upsert a saved market: update in-place if exists (by URL), or create if new.
 * Preserves favorite status and other user-set fields on update. */
export async function upsertSavedMarket(input: {
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  category?: string;
  expiryDate?: string | null;
  lastScanResult?: LastScanResult | null;
}): Promise<SavedMarket> {
  const markets = await getSavedMarkets();
  const normK = normalizeUrl(input.kalshiUrl);
  const normP = normalizeUrl(input.polymarketUrl);

  const idx = markets.findIndex(m =>
    normalizeUrl(m.kalshiUrl) === normK || normalizeUrl(m.polymarketUrl) === normP
  );

  if (idx >= 0) {
  // Update in-place — preserve favorite status and update expiryDate if fetched live
  const existing = markets[idx];
  const updated: SavedMarket = {
    ...existing,
    eventTitle: input.eventTitle,
    category: input.category ?? existing.category,
    expiryDate: input.expiryDate ?? existing.expiryDate,
    lastScanResult: input.lastScanResult ?? existing.lastScanResult,
  };
  await upsertMarketRow(updated);
  await mirrorMarketsToJson();
  return updated;
  }

  // New market — create
  const newMarket: SavedMarket = {
    kalshiUrl: input.kalshiUrl,
    polymarketUrl: input.polymarketUrl,
    eventTitle: input.eventTitle,
    category: input.category,
    expiryDate: input.expiryDate,
    favorite: false,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
    lastScanResult: input.lastScanResult ?? null,
  };
  await upsertMarketRow(newMarket);
  await mirrorMarketsToJson();
  return newMarket;
}

export async function updateSavedMarketScanResult(id: string, result: LastScanResult, expiryDate?: string | null): Promise<void> {
  // Targeted UPDATE — no read-modify-write of the whole list. This was the
  // main race: concurrent scans clobbering each other's lastScanResult.
  await ensureMarketsMigrated();
  const c = getClient();
  if (expiryDate !== undefined) {
    await c.execute({
      sql: 'UPDATE saved_markets SET last_scan_result = ?, expiry_date = ? WHERE id = ?',
      args: [JSON.stringify(result), expiryDate ?? null, id],
    });
  } else {
    await c.execute({
      sql: 'UPDATE saved_markets SET last_scan_result = ? WHERE id = ?',
      args: [JSON.stringify(result), id],
    });
  }
  await mirrorMarketsToJson();
}

export async function updateSavedMarket(id: string, updates: Partial<Pick<SavedMarket, 'eventTitle' | 'expiryDate' | 'category'>>): Promise<boolean> {
  await ensureMarketsMigrated();
  const c = getClient();
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (updates.eventTitle !== undefined) { sets.push('event_title = ?'); args.push(updates.eventTitle); }
  if (updates.expiryDate !== undefined) { sets.push('expiry_date = ?'); args.push(updates.expiryDate || null); }
  if (updates.category !== undefined) { sets.push('category = ?'); args.push(updates.category); }
  if (sets.length === 0) return false;
  args.push(id);
  const res = await c.execute({ sql: `UPDATE saved_markets SET ${sets.join(', ')} WHERE id = ?`, args });
  const changed = Number((res as any).rowsAffected ?? 0) > 0;
  if (changed) await mirrorMarketsToJson();
  return changed;
}

export async function deleteSavedMarket(id: string): Promise<boolean> {
  await ensureMarketsMigrated();
  const c = getClient();
  const res = await c.execute({ sql: 'DELETE FROM saved_markets WHERE id = ?', args: [id] });
  const deleted = Number((res as any).rowsAffected ?? 0) > 0;
  if (deleted) await mirrorMarketsToJson();
  return deleted;
}

// ── Scan History (OPS-009: SQLite-backed; JSON file retired) ─────

const SCAN_HISTORY_FILE = path.join(process.cwd(), 'data', 'scan-history.json');

export interface ScanHistoryEntry {
  scanTimestamp: string;    // ISO
  marketId: string;
  totalProfit: number;
  bestRoiPct: number;
  positiveArbCount: number;
  matchedCount: number;
}

// One-time migration of the legacy JSON history into SQLite.
let _historyMigrated = false;
async function ensureHistoryMigrated(): Promise<void> {
  if (_historyMigrated) return;
  await ensureDb();
  const c = getClient();
  const cnt = await c.execute('SELECT COUNT(*) AS cnt FROM scan_history');
  if (Number((cnt.rows as any[])[0]?.cnt ?? 0) === 0) {
    try {
      const data = await fs.readFile(SCAN_HISTORY_FILE, 'utf-8');
      const history: ScanHistoryEntry[] = JSON.parse(data);
      for (const e of history) {
        await c.execute({
          sql: `INSERT INTO scan_history (scan_timestamp, market_id, total_profit, best_roi_pct, positive_arb_count, matched_count)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [e.scanTimestamp, e.marketId, e.totalProfit ?? 0, e.bestRoiPct ?? 0, e.positiveArbCount ?? 0, e.matchedCount ?? 0],
        });
      }
      if (history.length > 0) console.log(`[OPS-009] Migrated ${history.length} scan-history entries from JSON to SQLite`);
    } catch { /* no legacy file */ }
  }
  _historyMigrated = true;
}

export async function appendScanHistory(entry: ScanHistoryEntry): Promise<void> {
  await ensureHistoryMigrated();
  const c = getClient();
  await c.execute({
    sql: `INSERT INTO scan_history (scan_timestamp, market_id, total_profit, best_roi_pct, positive_arb_count, matched_count)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [entry.scanTimestamp, entry.marketId, entry.totalProfit ?? 0, entry.bestRoiPct ?? 0, entry.positiveArbCount ?? 0, entry.matchedCount ?? 0],
  });
  // Bounded: keep the most recent 5000 rows (was 500 in JSON — cheap in SQLite)
  await c.execute(`DELETE FROM scan_history WHERE id NOT IN (SELECT id FROM scan_history ORDER BY scan_timestamp DESC LIMIT 5000)`);
}

/** @deprecated Use `getScanHistory` (scan_results table) instead. Reads the SQLite scan_history table. */
export async function getScanHistoryFromJson(limit: number = 100): Promise<ScanHistoryEntry[]> {
  await ensureHistoryMigrated();
  const c = getClient();
  const res = await c.execute({
    sql: 'SELECT * FROM scan_history ORDER BY scan_timestamp DESC LIMIT ?',
    args: [Math.min(Math.max(limit, 1), 5000)],
  });
  return (res.rows as any[]).map(r => ({
    scanTimestamp: String(r.scan_timestamp),
    marketId: String(r.market_id),
    totalProfit: Number(r.total_profit ?? 0),
    bestRoiPct: Number(r.best_roi_pct ?? 0),
    positiveArbCount: Number(r.positive_arb_count ?? 0),
    matchedCount: Number(r.matched_count ?? 0),
  }));
}