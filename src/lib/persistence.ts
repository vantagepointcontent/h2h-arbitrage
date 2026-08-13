import { promises as fs } from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import type { MarketLink } from './platforms/types';
import { calculateScanApy } from './scan-apy';
import { auditArbClassification } from './arb-types';
import { withSqliteBusyRetry } from './sqlite-write-retry';

const DATA_FILE = path.join(process.cwd(), 'data', 'saved-markets.json');

// ── SQLite (libsql) ──────────────────────────────────────────────

const SQLITE_PATH = process.env.H2H_SQLITE_PATH || path.join(process.cwd(), 'data', 'edgefinder.db');
let _client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (!_client) {
    _client = createClient({ url: `file:${SQLITE_PATH}` });
    // Wait up to 5s on writer contention instead of failing SQLITE_BUSY
    // (Next.js, poller-driven scans, and ws-watcher all write this file).
    void _client.execute('PRAGMA busy_timeout = 5000').catch(() => {});
    void _client.execute('PRAGMA journal_mode = WAL').catch(() => {});
    void _client.execute('PRAGMA synchronous = NORMAL').catch(() => {});
    // PERF-P3: keep WAL small (checkpoint every ~1000 pages ≈ 4MB), larger
    // page cache (16MB) and mmap (256MB) — the whole DB fits in memory.
    void _client.execute('PRAGMA wal_autocheckpoint = 1000').catch(() => {});
    void _client.execute('PRAGMA cache_size = -16000').catch(() => {});
    void _client.execute('PRAGMA mmap_size = 268435456').catch(() => {});
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
      market_title    TEXT,   -- human-readable market name (BUG-030: prevents raw IDs in Logs)
      kalshi_url      TEXT,   -- source Kalshi URL for re-scanning (not in saved_markets)
      polymarket_url  TEXT,   -- source Polymarket URL for re-scanning
      arb_type        TEXT,   -- ARB-01a: "cross" | "direct" | "internal"
      expiry_at       TEXT,   -- expiry timestamp captured by this scan
      days_to_expiry  REAL,   -- precise fractional TTE captured by this scan
      apy_pct         REAL,   -- canonical annualized ROI snapshot (%)
      apy_unavailable_reason TEXT,
      arb_valid       INTEGER NOT NULL DEFAULT 1,
      arb_invalidation_reason TEXT,
      scan_status     TEXT    NOT NULL DEFAULT 'completed'
    )
  `);
  // Migration: add columns if missing (existing DBs)
  for (const ddl of [
    `ALTER TABLE scan_results ADD COLUMN market_title TEXT`,
    `ALTER TABLE scan_results ADD COLUMN kalshi_url TEXT`,
    `ALTER TABLE scan_results ADD COLUMN polymarket_url TEXT`,
    `ALTER TABLE scan_results ADD COLUMN arb_type TEXT`,
    `ALTER TABLE scan_results ADD COLUMN expiry_at TEXT`,
    `ALTER TABLE scan_results ADD COLUMN days_to_expiry REAL`,
    `ALTER TABLE scan_results ADD COLUMN apy_pct REAL`,
    `ALTER TABLE scan_results ADD COLUMN apy_unavailable_reason TEXT`,
    `ALTER TABLE scan_results ADD COLUMN arb_valid INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE scan_results ADD COLUMN arb_invalidation_reason TEXT`,
    `ALTER TABLE scan_results ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'completed'`,
  ]) {
    try { await c.execute(ddl); } catch { /* column already exists */ }
  }
  await c.execute(`UPDATE scan_results
    SET arb_valid = 0,
        arb_invalidation_reason = 'legacy_internal_yes_yes_directional_duplication',
        arb_type = NULL,
        positive_arb_count = 0,
        best_profit = 0,
        best_roi_pct = 0,
        total_stake = 0,
        apy_pct = 0,
        apy_unavailable_reason = 'invalid_arb_classification'
    WHERE strategy LIKE 'Same-platform YES+YES%'
      AND (arb_valid <> 0 OR arb_invalidation_reason IS NULL)`);
  // Index for fast per-market lookups
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_scan_results_market_id ON scan_results(market_id)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_scan_results_scanned_at ON scan_results(scanned_at DESC)`);
  // PERF-P3: partial index for positiveArbOnly logs filter + dashboard top-arbs
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_scan_results_arbs ON scan_results(scanned_at DESC) WHERE positive_arb_count > 0`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_scan_results_arb_type_ts ON scan_results(arb_type, scanned_at DESC)`);

  // Market Catalog (FEAT-101): all open markets from Kalshi + Polymarket
  await c.execute(`
    CREATE TABLE IF NOT EXISTS market_catalog (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      platform        TEXT    NOT NULL,        -- 'kalshi' | 'polymarket'
      market_id       TEXT    NOT NULL,        -- platform-specific ID
      title           TEXT    NOT NULL,
      category        TEXT,
      event_id        TEXT,                  -- platform event ticker/slug
      event_title     TEXT,
      expiry_date     TEXT,                  -- close_time / endDate
      is_binary       INTEGER DEFAULT 1,     -- 1 YES/NO, 0 multi-outcome
      outcome_count   INTEGER DEFAULT 2,
      yes_bid         REAL,
      yes_ask         REAL,
      no_bid          REAL,
      no_ask          REAL,
      volume_24h      REAL,
      source_url      TEXT,
      fetched_at      TEXT    NOT NULL,      -- ISO timestamp
      stale           INTEGER DEFAULT 0,     -- 1 if not seen in latest refresh
      UNIQUE(platform, market_id)
    )
  `);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_market_catalog_platform ON market_catalog(platform, stale, fetched_at DESC)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_market_catalog_expiry ON market_catalog(expiry_date)`);
  // Migration: add columns that were added after initial launch (legacy DBs)
  const columnsToAdd = [
    { name: 'stale', def: 'INTEGER DEFAULT 0' },
    { name: 'event_id', def: 'TEXT' },
    { name: 'event_title', def: 'TEXT' },
    { name: 'is_binary', def: 'INTEGER DEFAULT 1' },
    { name: 'outcome_count', def: 'INTEGER DEFAULT 2' },
    { name: 'yes_bid', def: 'REAL' },
    { name: 'yes_ask', def: 'REAL' },
    { name: 'no_bid', def: 'REAL' },
    { name: 'no_ask', def: 'REAL' },
    { name: 'volume_24h', def: 'REAL' },
  ];
  for (const col of columnsToAdd) {
    try { await c.execute(`ALTER TABLE market_catalog ADD COLUMN ${col.name} ${col.def}`); } catch { /* column already exists */ }
  }

  // UI-033: per-API capacity utilization history (rate limiter snapshots)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS rate_limiter_metrics (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      limiter_name      TEXT    NOT NULL,
      timestamp         TEXT    NOT NULL,
      total_requests    INTEGER NOT NULL DEFAULT 0,
      queued_requests   INTEGER NOT NULL DEFAULT 0,
      rejected_requests INTEGER NOT NULL DEFAULT 0,
      retry_429_count   INTEGER NOT NULL DEFAULT 0,
      avg_queue_wait_ms INTEGER NOT NULL DEFAULT 0,
      tokens_available  INTEGER NOT NULL DEFAULT 0,
      is_throttled      INTEGER NOT NULL DEFAULT 0,
      effective_rate    REAL    NOT NULL DEFAULT 0,
      refill_interval_ms INTEGER NOT NULL DEFAULT 0
    )
  `);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_rate_limiter_metrics_name_ts ON rate_limiter_metrics(limiter_name, timestamp DESC)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_rate_limiter_metrics_ts ON rate_limiter_metrics(timestamp DESC)`);

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
  // AUTO-002: lifecycle columns (archive expired/dead markets)
  for (const ddl of [
    // BUG-138: CREATE TABLE IF NOT EXISTS does not upgrade pre-OPS-009
    // databases. Add every post-legacy base column before startup queries use
    // SELECT *, APY joins, or refresh publication state.
    `ALTER TABLE saved_markets ADD COLUMN category TEXT`,
    `ALTER TABLE saved_markets ADD COLUMN expiry_date TEXT`,
    `ALTER TABLE saved_markets ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE saved_markets ADD COLUMN last_scan_result TEXT`,
    `ALTER TABLE saved_markets ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE saved_markets ADD COLUMN archived_at TEXT`,
    `ALTER TABLE saved_markets ADD COLUMN archive_reason TEXT`,
    `ALTER TABLE saved_markets ADD COLUMN last_matched_at TEXT`,
    // WS-107: real-time result written by the ws-watcher for HOT pairs
    `ALTER TABLE saved_markets ADD COLUMN live_result TEXT`,
    // BUG-133: reserve request order before upstream work so equal-time
    // completions cannot publish in arrival order.
    `ALTER TABLE saved_markets ADD COLUMN scan_publication_generation INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE saved_markets ADD COLUMN live_publication_generation INTEGER NOT NULL DEFAULT 0`,
    // FEAT-3: retain legacy URL columns during the N-platform migration.
    `ALTER TABLE saved_markets ADD COLUMN platform_links TEXT`,
  ]) {
    try { await c.execute(ddl); } catch { /* column already exists */ }
  }

  // UI-046: a B-tree cannot accelerate LIKE '%term%'. Trigram FTS does,
  // while preserving case-insensitive contains semantics across all existing
  // searchable fields and the saved-market title fallback.
  await c.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS scan_results_search USING fts5(
    search_text, tokenize='trigram case_sensitive 0'
  )`);
  await c.execute(`CREATE TRIGGER IF NOT EXISTS scan_results_search_insert AFTER INSERT ON scan_results BEGIN
    INSERT INTO scan_results_search(rowid, search_text)
    VALUES (new.id, new.market_id || ' ' || COALESCE(new.market_title, '') || ' ' || new.strategy || ' ' || COALESCE((SELECT event_title FROM saved_markets WHERE id = new.market_id), ''));
  END`);
  await c.execute(`CREATE TRIGGER IF NOT EXISTS scan_results_search_update AFTER UPDATE OF market_id, market_title, strategy ON scan_results BEGIN
    DELETE FROM scan_results_search WHERE rowid = old.id;
    INSERT INTO scan_results_search(rowid, search_text)
    VALUES (new.id, new.market_id || ' ' || COALESCE(new.market_title, '') || ' ' || new.strategy || ' ' || COALESCE((SELECT event_title FROM saved_markets WHERE id = new.market_id), ''));
  END`);
  await c.execute(`CREATE TRIGGER IF NOT EXISTS scan_results_search_delete AFTER DELETE ON scan_results BEGIN
    DELETE FROM scan_results_search WHERE rowid = old.id;
  END`);
  await c.execute(`CREATE TRIGGER IF NOT EXISTS scan_results_search_market_title_update AFTER UPDATE OF event_title ON saved_markets BEGIN
    DELETE FROM scan_results_search WHERE rowid IN (SELECT id FROM scan_results WHERE market_id = new.id);
    INSERT INTO scan_results_search(rowid, search_text)
      SELECT id, market_id || ' ' || COALESCE(market_title, '') || ' ' || strategy || ' ' || COALESCE(new.event_title, '')
      FROM scan_results WHERE market_id = new.id;
  END`);
  const [scanCount, searchCount] = await Promise.all([
    c.execute(`SELECT COUNT(*) AS cnt FROM scan_results`),
    c.execute(`SELECT COUNT(*) AS cnt FROM scan_results_search`),
  ]);
  if (Number(scanCount.rows[0]?.cnt ?? 0) !== Number(searchCount.rows[0]?.cnt ?? 0)) {
    await c.execute(`DELETE FROM scan_results_search`);
    await c.execute(`INSERT INTO scan_results_search(rowid, search_text)
      SELECT r.id, r.market_id || ' ' || COALESCE(r.market_title, '') || ' ' || r.strategy || ' ' || COALESCE(m.event_title, '')
      FROM scan_results r LEFT JOIN saved_markets m ON m.id = r.market_id`);
  }

  // BUG-128: one-time, idempotent backfill. Prefer expiry embedded in the
  // immutable scan payload, with the saved market's recorded expiry as the
  // legacy fallback. Always annualize from scanned_at, never from Date.now().
  const apyBackfill = await c.execute(`
    SELECT r.id, r.best_roi_pct, r.scanned_at, r.raw_result, m.expiry_date
    FROM scan_results r
    LEFT JOIN saved_markets m ON m.id = r.market_id
    WHERE r.apy_pct IS NULL AND r.apy_unavailable_reason IS NULL
  `);
  for (const row of apyBackfill.rows as unknown as Array<Record<string, unknown>>) {
    let expiryAt = typeof row.expiry_date === 'string' ? row.expiry_date : null;
    if (typeof row.raw_result === 'string') {
      try {
        const raw = JSON.parse(row.raw_result) as { expiryDate?: unknown };
        if (typeof raw.expiryDate === 'string') expiryAt = raw.expiryDate;
      } catch { /* malformed payload may still use saved-market expiry */ }
    }
    const snapshot = calculateScanApy(Number(row.best_roi_pct), String(row.scanned_at), expiryAt);
    await c.execute({
      sql: `UPDATE scan_results
            SET expiry_at = ?, days_to_expiry = ?, apy_pct = ?, apy_unavailable_reason = ?
            WHERE id = ? AND apy_pct IS NULL AND apy_unavailable_reason IS NULL`,
      args: [expiryAt, snapshot.daysToExpiry, snapshot.apyPct, snapshot.unavailableReason, Number(row.id)],
    });
  }
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
let _dbInitPromise: Promise<void> | null = null;

/**
 * CORRUPT-001: Startup integrity guard.
 * Runs SQLite's bounded single-error quick check on the SQLite DB. If corrupt, attempts to
 * restore from the latest good backup in data/backups/ before initDb().
 * Logs to stderr so it shows up in PM2/process logs.
 */
async function checkAndRestoreDb(): Promise<void> {
  const c = getClient();
  try {
    const result = await c.execute('PRAGMA quick_check(1)');
    const status = (result.rows as any[])[0]?.['quick_check'] ?? 'ok';
    if (status === 'ok') return;

    console.error(`[persistence] DB CORRUPT: quick_check = ${status}. Attempting restore...`);

    // Find latest backup
    const backupDir = path.join(process.cwd(), 'data', 'backups');
    const fs2 = await import('fs');
    if (!fs2.existsSync(backupDir)) {
      console.error(`[persistence] No backup directory at ${backupDir}. Cannot restore.`);
      return;
    }
    const backups = fs2.readdirSync(backupDir)
      .filter((f: string) => f.startsWith('edgefinder-') && f.endsWith('.db'))
      .sort()
      .reverse();
    if (backups.length === 0) {
      console.error(`[persistence] No backups found in ${backupDir}. Cannot restore.`);
      return;
    }

    const latest = backups[0];
    const backupPath = path.join(backupDir, latest);
    console.error(`[persistence] Restoring from ${backupPath}`);

    // Close current client, copy backup over DB, reset client
    _client = null;
    // Remove WAL/SHM — they belong to the old corrupt DB
    for (const ext of ['-wal', '-shm']) {
      const p = SQLITE_PATH + ext;
      try { fs2.unlinkSync(p); } catch { /* may not exist */ }
    }
    fs2.copyFileSync(backupPath, SQLITE_PATH);
    console.error(`[persistence] Restored DB from ${latest}. Re-initializing.`);
  } catch (err) {
    // Non-fatal: if integrity check itself fails, let initDb try anyway
    console.error(`[persistence] Integrity check error (non-fatal):`, err);
  }
}

async function ensureDb(): Promise<void> {
  if (_dbInited) return;
  if (!_dbInitPromise) {
    _dbInitPromise = (async () => {
      await checkAndRestoreDb();
      await initDb();
      _dbInited = true;
    })().catch((error) => {
      _dbInitPromise = null;
      throw error;
    });
  }
  await _dbInitPromise;
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
    kalshiUrl?: string;
    polymarketUrl?: string;
    arbType?: 'cross' | 'direct' | 'internal';
    expiryAt?: string | null;
  },
): Promise<{ id: number }> {
  await ensureDb();
  const c = getClient();
  const scannedAt = result.scannedAt ?? new Date().toISOString();
  const audit = auditArbClassification(result.strategy, result.arbType);
  const financiallyValid = audit.valid && audit.canonicalType !== null;
  const canonicalRoi = financiallyValid ? (result.bestRoiPct ?? 0) : 0;
  const snapshot = financiallyValid
    ? calculateScanApy(canonicalRoi, scannedAt, result.expiryAt)
    : { daysToExpiry: null, apyPct: 0, unavailableReason: audit.valid ? 'no_arbitrage' : 'invalid_arb_classification' };
  const row = await c.execute({
    sql: `INSERT INTO scan_results
      (market_id, best_roi_pct, best_profit, strategy,
       outcome_count, matched_count, kalshi_count, pm_count,
       positive_arb_count, total_stake, scanned_at, raw_result, market_title,
       kalshi_url, polymarket_url, arb_type, expiry_at, days_to_expiry,
       apy_pct, apy_unavailable_reason, arb_valid, arb_invalidation_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      marketId,
      canonicalRoi,
      financiallyValid ? (result.bestProfit ?? 0) : 0,
      result.strategy ?? '',
      result.outcomeCount ?? 0,
      result.matchedCount ?? 0,
      result.kalshiCount ?? 0,
      result.pmCount ?? 0,
      financiallyValid ? (result.positiveArbCount ?? 0) : 0,
      financiallyValid ? (result.totalStake ?? 0) : 0,
      scannedAt,
      typeof result.raw === 'string' ? result.raw : (result.raw ? JSON.stringify(result.raw) : null),
      result.marketTitle ?? null,
      result.kalshiUrl ?? null,
      result.polymarketUrl ?? null,
      audit.canonicalType,
      result.expiryAt ?? null,
      snapshot.daysToExpiry,
      snapshot.apyPct,
      snapshot.unavailableReason,
      financiallyValid ? 1 : 0,
      audit.reason,
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

/** Return the oldest scan timestamp in the DB, or null if no scans exist. */
export async function getOldestScan(): Promise<string | null> {
  await ensureDb();
  const c = getClient();
  const result = await c.execute('SELECT MIN(scanned_at) AS oldest FROM scan_results');
  const oldest = (result.rows as any[])?.[0]?.oldest;
  return oldest != null ? String(oldest) : null;
}

/** PERF-P1: Look up Kalshi & Polymarket URLs from scan_results by market_id.
 * Uses the idx_scan_results_market_id index — single-column SELECT, no blob.
 * Returns the most recent non-null pair, or null if none found. */
export async function getMarketUrlsById(marketId: string): Promise<{ kalshiUrl: string; polymarketUrl: string } | null> {
  await ensureDb();
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT kalshi_url, polymarket_url FROM scan_results
          WHERE market_id = ? AND kalshi_url IS NOT NULL AND polymarket_url IS NOT NULL
          ORDER BY scanned_at DESC LIMIT 1`,
    args: [marketId],
  });
  const row = (res.rows as any[])[0];
  if (!row?.kalshi_url || !row?.polymarket_url) return null;
  return { kalshiUrl: String(row.kalshi_url), polymarketUrl: String(row.polymarket_url) };
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

/**
 * PERF-P1: SQL-side filtered scan history for /api/logs.
 * Filters run in SQLite (indexed on scanned_at DESC) instead of loading
 * 10k rows into JS. Excludes the heavy raw_result blob.
 * Returns { rows, total } where total counts all matches (pre-LIMIT).
 */
type ScanHistoryFilters = {
  marketId?: string; minRoi?: number; positiveArbOnly?: boolean; fromDate?: string; toDate?: string;
  search?: string; eventType?: 'all' | 'scan' | 'arb' | 'system'; arbType?: 'all' | 'direct' | 'cross' | 'internal';
  maxTteDays?: 30 | 90 | 180;
};
type ScanHistorySummary = { totalArbs: number; avgRoi: number; bestRoi: number; totalProfit: number; arbTypeCounts: { direct: number; cross: number; internal: number } };
type ScanHistoryRow = Record<string, unknown> & { id: number; market_id: string; scanned_at: string };

function scanHistoryWhere(opts: ScanHistoryFilters) {
  let where = ' WHERE 1=1';
  const args: (string | number)[] = [];
  if (opts.marketId) { where += ' AND market_id = ?'; args.push(opts.marketId); }
  if (opts.minRoi !== undefined && !isNaN(opts.minRoi)) { where += ' AND best_roi_pct >= ?'; args.push(opts.minRoi); }
  if (opts.positiveArbOnly) where += ' AND arb_valid = 1 AND positive_arb_count > 0';
  if (opts.maxTteDays !== undefined) {
    where += ' AND days_to_expiry >= 0 AND days_to_expiry < ?';
    args.push(opts.maxTteDays);
  }
  if (opts.fromDate) { where += ' AND scanned_at >= ?'; args.push(new Date(opts.fromDate).toISOString()); }
  if (opts.toDate) { where += ' AND scanned_at <= ?'; args.push(new Date(opts.toDate).toISOString()); }
  const search = opts.search?.trim();
  if (search) {
    if (Array.from(search).length >= 3) {
      where += ` AND id IN (SELECT rowid FROM scan_results_search WHERE scan_results_search MATCH ?)`;
      args.push(`"${search.replace(/"/g, '""')}"`);
    } else {
      const literalLike = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      where += ` AND id IN (SELECT rowid FROM scan_results_search WHERE search_text LIKE ? ESCAPE '\\')`;
      args.push(`%${literalLike}%`);
    }
  }
  if (opts.eventType === 'arb') where += ' AND arb_valid = 1 AND positive_arb_count > 0';
  if (opts.eventType === 'scan') where += ' AND positive_arb_count = 0';
  if (opts.eventType === 'system') where += ' AND (matched_count = 0 OR kalshi_count = 0 OR pm_count = 0)';
  if (opts.arbType && opts.arbType !== 'all') {
    where += ` AND arb_valid = 1 AND COALESCE(arb_type, CASE WHEN strategy LIKE 'Buy YES both sides:%' THEN 'cross' WHEN strategy LIKE 'Same-platform YES+NO%' THEN 'internal' WHEN strategy LIKE 'Buy YES%' THEN 'direct' END) = ?`;
    args.push(opts.arbType);
  }
  return { where, args };
}

/** Diagnostic used by database tests to assert substring search uses FTS. */
export async function explainScanHistorySearchPlan(search: string): Promise<string[]> {
  await ensureDb();
  const phrase = `"${search.trim().replace(/"/g, '""')}"`;
  const result = await getClient().execute({
    sql: `EXPLAIN QUERY PLAN SELECT rowid FROM scan_results_search WHERE scan_results_search MATCH ?`,
    args: [phrase],
  });
  return result.rows.map((row) => String(row.detail ?? ''));
}

export async function queryScanHistory(opts: ScanHistoryFilters & { limit?: number; before?: { scannedAt: string; id: number } }): Promise<{ rows: ScanHistoryRow[]; total: number; uniqueMarkets: number; maxRoiWithoutMin: number; summary: ScanHistorySummary }> {
  await ensureDb();
  const c = getClient();
  const limit = Math.min(Math.max(opts.limit ?? 250, 1), 500);
  const base = scanHistoryWhere(opts);
  const rangeBase = scanHistoryWhere({ ...opts, minRoi: undefined });

  const [countRes, rangeRes] = await Promise.all([
    c.execute({
      sql: `SELECT COUNT(*) AS cnt, COUNT(DISTINCT market_id) AS unique_markets, COALESCE(SUM(positive_arb_count), 0) AS total_arbs, COALESCE(AVG(best_roi_pct), 0) AS avg_roi, COALESCE(MAX(best_roi_pct), 0) AS best_roi, COALESCE(SUM(best_profit), 0) AS total_profit,
        SUM(CASE WHEN arb_valid = 1 AND arb_type = 'direct' THEN 1 ELSE 0 END) AS direct_count,
        SUM(CASE WHEN arb_valid = 1 AND arb_type = 'cross' THEN 1 ELSE 0 END) AS cross_count,
        SUM(CASE WHEN arb_valid = 1 AND arb_type = 'internal' THEN 1 ELSE 0 END) AS internal_count FROM scan_results${base.where}`,
      args: base.args,
    }),
    c.execute({
      sql: `SELECT COALESCE(MAX(best_roi_pct), 0) AS max_roi FROM scan_results${rangeBase.where}`,
      args: rangeBase.args,
    }),
  ]);
  const countRow = countRes.rows[0];
  const total = Number(countRow?.cnt ?? 0);
  const uniqueMarkets = Number(countRow?.unique_markets ?? 0);
  let pageWhere = base.where;
  const pageArgs = [...base.args];
  if (opts.before) { pageWhere += ' AND (scanned_at < ? OR (scanned_at = ? AND id < ?))'; pageArgs.push(opts.before.scannedAt, opts.before.scannedAt, opts.before.id); }

  const rows = await c.execute({
    sql: `SELECT id, market_id, market_title, best_roi_pct, best_profit, strategy,
                 outcome_count, matched_count, kalshi_count, pm_count,
                 positive_arb_count, total_stake, scanned_at,
                 expiry_at, days_to_expiry, apy_pct, apy_unavailable_reason,
                 arb_type, arb_valid, arb_invalidation_reason
          FROM scan_results${pageWhere}
          ORDER BY scanned_at DESC, id DESC LIMIT ?`,
    args: [...pageArgs, limit],
  });
  const rawMaxRoiWithoutMin = Number(rangeRes.rows[0]?.max_roi ?? 0);
  const maxRoiWithoutMin = Number.isFinite(rawMaxRoiWithoutMin) ? Math.max(0, rawMaxRoiWithoutMin) : 0;
  return { rows: Array.isArray(rows.rows) ? (rows.rows as unknown as ScanHistoryRow[]) : [], total, uniqueMarkets, maxRoiWithoutMin, summary: {
    totalArbs: Number(countRow?.total_arbs ?? 0), avgRoi: Number(countRow?.avg_roi ?? 0), bestRoi: Number(countRow?.best_roi ?? 0), totalProfit: Number(countRow?.total_profit ?? 0),
    arbTypeCounts: { direct: Number(countRow?.direct_count ?? 0), cross: Number(countRow?.cross_count ?? 0), internal: Number(countRow?.internal_count ?? 0) },
  } };
}

/** Load the heavy immutable payload only when a Logs row is expanded. */
export async function getScanHistoryDetail(id: number): Promise<{ id: number; raw_result: string | null } | null> {
  await ensureDb();
  const result = await getClient().execute({
    sql: 'SELECT id, raw_result FROM scan_results WHERE id = ? LIMIT 1',
    args: [id],
  });
  const row = result.rows[0];
  return row ? { id: Number(row.id), raw_result: typeof row.raw_result === 'string' ? row.raw_result : null } : null;
}

export interface ScanValuationInput {
  id: number;
  kalshiUrl: string | null;
  polymarketUrl: string | null;
  scanCapital: number | null;
  candidates: Array<{
    kalshiTicker: string;
    pmConditionId: string;
    strategy: string;
    arbType: 'cross' | 'direct' | 'internal';
  }>;
}

/** Load the immutable URL pair, requested capital, and captured strategy identities. */
export async function getScanValuationInputs(ids: number[]): Promise<ScanValuationInput[]> {
  await ensureDb();
  const uniqueIds = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0).slice(0, 25);
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const result = await getClient().execute({
    sql: `SELECT id, kalshi_url, polymarket_url, raw_result FROM scan_results WHERE id IN (${placeholders})`,
    args: uniqueIds,
  });
  return result.rows.map((row) => {
    let raw: Record<string, unknown> = {};
    try {
      const parsed = typeof row.raw_result === 'string' ? JSON.parse(row.raw_result) : null;
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
    } catch { /* Invalid historical payloads are explicitly unavailable. */ }
    const scanCapital = Number(raw.scanCapital);
    const candidates: ScanValuationInput['candidates'] = Array.isArray(raw.allArbs) ? raw.allArbs.flatMap((candidate): ScanValuationInput['candidates'] => {
      if (!candidate || typeof candidate !== 'object') return [];
      const value = candidate as Record<string, unknown>;
      if (typeof value.kalshiTicker !== 'string' || typeof value.pmConditionId !== 'string'
        || typeof value.strategy !== 'string'
        || (value.arbType !== 'cross' && value.arbType !== 'direct' && value.arbType !== 'internal')) return [];
      const arbType = value.arbType as ScanValuationInput['candidates'][number]['arbType'];
      return [{
        kalshiTicker: value.kalshiTicker,
        pmConditionId: value.pmConditionId,
        strategy: value.strategy,
        arbType,
      }];
    }) : [];
    return {
      id: Number(row.id),
      kalshiUrl: typeof row.kalshi_url === 'string' ? row.kalshi_url : null,
      polymarketUrl: typeof row.polymarket_url === 'string' ? row.polymarket_url : null,
      scanCapital: Number.isFinite(scanCapital) && scanCapital > 0 ? scanCapital : null,
      candidates,
    };
  });
}

export type PersistedCurrentLogRoiStatus = 'available' | 'no_arbitrage' | 'never_scanned' | 'unavailable';

export interface PersistedCurrentLogRoi {
  id: number;
  status: PersistedCurrentLogRoiStatus;
  roiPct?: number;
  strategy?: string;
  scannedAt?: string;
  scanId?: number;
}

/**
 * Resolve Logs Current ROI from the newest completed persisted scan for each
 * row's exact linked-event URL pair. One bounded query handles all distinct
 * pairs; titles and market ids are deliberately excluded from identity.
 */
export async function getLatestCompletedScanRoiForLogIds(ids: number[]): Promise<PersistedCurrentLogRoi[]> {
  await ensureDb();
  const uniqueIds = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0).slice(0, 100);
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const result = await getClient().execute({
    sql: `WITH requested AS (
            SELECT id, kalshi_url, polymarket_url, scan_status
            FROM scan_results
            WHERE id IN (${placeholders})
          ), distinct_pairs AS (
            SELECT DISTINCT kalshi_url, polymarket_url
            FROM requested
            WHERE kalshi_url IS NOT NULL AND kalshi_url <> ''
              AND polymarket_url IS NOT NULL AND polymarket_url <> ''
          ), ranked AS (
            SELECT p.kalshi_url, p.polymarket_url,
                   s.id AS scan_id, s.best_roi_pct, s.strategy, s.positive_arb_count,
                   s.arb_valid, s.apy_unavailable_reason, s.scanned_at,
                   ROW_NUMBER() OVER (
                     PARTITION BY p.kalshi_url, p.polymarket_url
                     ORDER BY s.scanned_at DESC, s.id DESC
                   ) AS scan_rank
            FROM distinct_pairs p
            JOIN scan_results s
              ON s.kalshi_url = p.kalshi_url
             AND s.polymarket_url = p.polymarket_url
             AND s.scan_status = 'completed'
          )
          SELECT r.id, r.kalshi_url, r.polymarket_url, r.scan_status AS requested_scan_status,
                 latest.scan_id, latest.best_roi_pct, latest.strategy,
                 latest.positive_arb_count, latest.arb_valid,
                 latest.apy_unavailable_reason, latest.scanned_at
          FROM requested r
          LEFT JOIN ranked latest
            ON latest.kalshi_url = r.kalshi_url
           AND latest.polymarket_url = r.polymarket_url
           AND latest.scan_rank = 1`,
    args: uniqueIds,
  });
  const rowsById = new Map(result.rows.map((row) => [Number(row.id), row]));

  return uniqueIds.map((id) => {
    const row = rowsById.get(id);
    if (!row) return { id, status: 'never_scanned' as const };
    if (typeof row.kalshi_url !== 'string' || row.kalshi_url.length === 0
      || typeof row.polymarket_url !== 'string' || row.polymarket_url.length === 0) {
      return { id, status: 'unavailable' as const };
    }
    const scanId = Number(row.scan_id);
    if (!Number.isSafeInteger(scanId) || scanId <= 0) {
      return { id, status: row.requested_scan_status === 'completed' ? 'never_scanned' as const : 'unavailable' as const };
    }
    const scannedAt = typeof row.scanned_at === 'string' ? row.scanned_at : undefined;
    const common = { id, scanId, ...(scannedAt ? { scannedAt } : {}) };
    const positiveArbCount = Number(row.positive_arb_count);
    if (!Number.isSafeInteger(positiveArbCount) || positiveArbCount < 0) {
      return { id, status: 'unavailable' as const };
    }
    if (positiveArbCount === 0) {
      return row.arb_valid === 1 || row.apy_unavailable_reason === 'no_arbitrage'
        ? { ...common, status: 'no_arbitrage' as const }
        : { id, status: 'unavailable' as const };
    }
    const roiPct = Number(row.best_roi_pct);
    if (row.arb_valid !== 1 || !Number.isFinite(roiPct)) {
      return { id, status: 'unavailable' as const };
    }
    return {
      ...common,
      status: 'available' as const,
      roiPct,
      ...(typeof row.strategy === 'string' && row.strategy ? { strategy: row.strategy } : {}),
    };
  });
}

/**
 * UI-035: chunked, streaming-friendly scan history export.
 *
 * Yields batches of 500 slim rows (no raw_result blob) so a route can stream
 * 50k+ rows to the client without holding them all in memory. Filters run in
 * SQLite, indexed on scanned_at DESC.
 */
export async function* queryScanHistoryStream(opts: ScanHistoryFilters & {
  maxRows?: number;
  chunkSize?: number;
}): AsyncGenerator<any[], void, unknown> {
  await ensureDb();
  const c = getClient();
  const maxRows = opts.maxRows === undefined ? Number.POSITIVE_INFINITY : Math.max(opts.maxRows, 1);
  const chunkSize = Math.min(Math.max(opts.chunkSize ?? 500, 1), 2000);

  const { where, args } = scanHistoryWhere(opts);

  let emitted = 0;
  let lastCursor: { scannedAt: string; id: number } | null = null;

  while (emitted < maxRows) {
    const thisLimit = Number.isFinite(maxRows) ? Math.min(chunkSize, maxRows - emitted) : chunkSize;
    let cursorWhere = where;
    const cursorArgs = [...args];
    if (lastCursor) {
      cursorWhere += ' AND (scanned_at < ? OR (scanned_at = ? AND id < ?))';
      cursorArgs.push(lastCursor.scannedAt, lastCursor.scannedAt, lastCursor.id);
    }

    const res = await c.execute({
      sql: `SELECT id, market_id, market_title, best_roi_pct, best_profit, strategy,
                   outcome_count, matched_count, kalshi_count, pm_count,
                   positive_arb_count, total_stake, scanned_at,
                   expiry_at, days_to_expiry, apy_pct, apy_unavailable_reason,
                   arb_type, arb_valid, arb_invalidation_reason
            FROM scan_results${cursorWhere}
            ORDER BY scanned_at DESC, id DESC LIMIT ?`,
      args: [...cursorArgs, thisLimit],
    });

    const batch = Array.isArray(res.rows) ? (res.rows as any[]) : [];
    if (batch.length === 0) break;

    yield batch;
    emitted += batch.length;
    const lastRow = batch[batch.length - 1];
    lastCursor = { scannedAt: lastRow.scanned_at as string, id: Number(lastRow.id) };

    if (batch.length < thisLimit) break;
  }
}

/** UI-035: exact match count for the export row estimate (no blob read). */
export async function countScanHistory(opts: ScanHistoryFilters): Promise<number> {
  await ensureDb();
  const c = getClient();

  const { where, args } = scanHistoryWhere(opts);

  const countRes = await c.execute({ sql: `SELECT COUNT(*) AS cnt FROM scan_results${where}`, args });
  return Number((countRes.rows as any[])[0]?.cnt ?? 0);
}

/**
 * PERF-P1: slim scan rows for dashboard aggregation.
 * Date filter in SQL (indexed scanned_at), and only the columns the
 * dashboard aggregates — excludes raw_result blobs which dominate row size.
 */
export async function getScanRowsSince(since?: string): Promise<any[]> {
  await ensureDb();
  const c = getClient();
  const cols = `id, market_id, market_title, best_roi_pct, best_profit, strategy,
                positive_arb_count, scanned_at`;
  const res = since
    ? await c.execute({
        sql: `SELECT ${cols} FROM scan_results WHERE scanned_at >= ? ORDER BY scanned_at DESC LIMIT 50000`,
        args: [since],
      })
    : await c.execute(`SELECT ${cols} FROM scan_results ORDER BY scanned_at DESC LIMIT 50000`);
  return Array.isArray(res.rows) ? (res.rows as any[]) : [];
}

/**
 * PERF-P4: full-SQL dashboard aggregation. Replaces JS loops over 35k+ rows
 * with GROUP BY queries (indexed scanned_at + partial arbs index).
 * `suspiciousRoi` mirrors the phantom guard: rows above it stay in scan
 * counts/histograms but are excluded from ROI/profit KPIs and top arbs.
 */
export async function getDashboardAggregates(since: string | undefined, suspiciousRoi: number): Promise<{
  kpis: { totalScans: number; totalArbsFound: number; activeArbs: number; avgRoi: number; marketsTracked: number; totalProfit: number };
  scansPerDay: { date: string; count: number }[];
  roiBuckets: { label: string; low: number; high: number; count: number }[];
  timeline: { time: string; scans: number; avgRoi: number }[];
  profitTimeline: { time: string; profit: number }[];
  // NOTE: topActiveArbs removed from SQL — now computed from savedMarkets
  // in the stats route to match the sidebar's live data source.
  recurringArbs: number;
  vanishedArbs: number;
  arbTypeBreakdown: { type: string; count: number; totalProfit: number; avgRoi: number }[];
}> {
  await ensureDb();
  const c = getClient();
  const w = since ? 'WHERE scanned_at >= ?' : 'WHERE 1=1';
  const args: (string | number)[] = since ? [since] : [];
  const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 3600000).toISOString();

  // topActiveArbs SQL removed — computed from savedMarkets in stats route
  const [kpiRes, perDayRes, bucketRes, hourRes, profitRes, recurRes, vanishedRes, arbTypeRes] = await Promise.all([
    c.execute({
      sql: `SELECT
              COUNT(*) AS total_scans,
              COUNT(DISTINCT market_id) AS markets_tracked,
              SUM(CASE WHEN best_roi_pct <= ? THEN positive_arb_count ELSE 0 END) AS total_arbs,
              -- BUG-01: active_arbs is no longer used for the dashboard counter.
              -- The stats route now computes activeArbs from saved_markets
              -- (liveResult ?? lastScanResult, bestRoiPct > 0) to match the
              -- MarketSidebar "Arb Only" filter. This SQL value is kept only for
              -- the lifecycle funnel's "active" field.
              SUM(CASE WHEN best_roi_pct <= ? AND positive_arb_count > 0 AND scanned_at >= ? THEN positive_arb_count ELSE 0 END) AS active_arbs,
              AVG(CASE WHEN best_roi_pct <= ? THEN best_roi_pct END) AS avg_roi,
              SUM(CASE WHEN best_roi_pct <= ? THEN best_profit ELSE 0 END) AS total_profit
            FROM scan_results ${w}`,
      args: [suspiciousRoi, suspiciousRoi, fiveMinAgo, suspiciousRoi, suspiciousRoi, ...args],
    }),
    c.execute({
      sql: `SELECT substr(scanned_at, 1, 10) AS day, COUNT(*) AS cnt
            FROM scan_results ${w} GROUP BY day`,
      args,
    }),
    c.execute({
      sql: `SELECT
              SUM(CASE WHEN best_roi_pct >= 0  AND best_roi_pct < 2  THEN 1 ELSE 0 END) AS b0,
              SUM(CASE WHEN best_roi_pct >= 2  AND best_roi_pct < 5  THEN 1 ELSE 0 END) AS b1,
              SUM(CASE WHEN best_roi_pct >= 5  AND best_roi_pct < 10 THEN 1 ELSE 0 END) AS b2,
              SUM(CASE WHEN best_roi_pct >= 10 AND best_roi_pct < 20 THEN 1 ELSE 0 END) AS b3,
              SUM(CASE WHEN best_roi_pct >= 20 THEN 1 ELSE 0 END) AS b4
            FROM scan_results ${w}`,
      args,
    }),
    c.execute({
      sql: `SELECT substr(scanned_at, 1, 13) || ':00:00' AS hour,
                   COUNT(*) AS scans, AVG(best_roi_pct) AS avg_roi
            FROM scan_results ${w} GROUP BY hour ORDER BY hour`,
      args,
    }),
    c.execute({
      sql: `SELECT substr(scanned_at, 1, 13) || ':00:00' AS hour,
                   SUM(best_profit) AS profit
            FROM scan_results ${w} GROUP BY hour ORDER BY hour`,
      args,
    }),
    c.execute({
      sql: `SELECT COUNT(*) AS cnt FROM (
              SELECT market_id FROM scan_results ${w}
              GROUP BY market_id HAVING COUNT(*) > 1
            )`,
      args,
    }),
    c.execute({
      // Markets that had positive arbs in-range but no scans in the last 24h
      sql: `SELECT COUNT(*) AS cnt FROM (
              SELECT DISTINCT market_id FROM scan_results ${w} AND positive_arb_count > 0
            ) a
            WHERE market_id NOT IN (
              SELECT DISTINCT market_id FROM scan_results WHERE scanned_at >= ?
            )`,
      args: [...args, dayAgo],
    }),
    c.execute({
      // Arb type breakdown — classify from strategy string.
      // Only counts positive-arb scans (positive_arb_count > 0) with non-phantom ROI.
      sql: `SELECT
              CASE
                WHEN strategy LIKE '%both sides%' THEN 'cross'
                WHEN strategy LIKE 'Same-platform YES+NO%' THEN 'internal'
                WHEN strategy LIKE 'Buy YES%' THEN 'direct'
                ELSE 'unknown'
              END AS arb_type,
              COUNT(*) AS cnt,
              SUM(best_profit) AS total_profit,
              AVG(best_roi_pct) AS avg_roi
            FROM scan_results ${w}
              AND arb_valid = 1
              AND positive_arb_count > 0
              AND best_roi_pct <= ?
            GROUP BY arb_type`,
      args: [...args, suspiciousRoi],
    }),
  ]);

  const k = (kpiRes.rows as any[])[0] ?? {};
  const bucketRow = (bucketRes.rows as any[])[0] ?? {};
  // Keep low/high — DashboardPanel colors buckets by b.low
  const bucketDefs = [
    { label: '0–2%', low: 0, high: 2 },
    { label: '2–5%', low: 2, high: 5 },
    { label: '5–10%', low: 5, high: 10 },
    { label: '10–20%', low: 10, high: 20 },
    { label: '20%+', low: 20, high: Infinity },
  ];
  const perDay = new Map((perDayRes.rows as any[]).map((r) => [r.day, Number(r.cnt)]));

  // Scans-per-day: number of buckets matches the selected range (not hardcoded 30).
  // Fills gaps with 0 so the chart shows continuous days.
  const rangeDays = since
    ? Math.min(Math.max(Math.ceil((Date.now() - new Date(since).getTime()) / 86400000), 1), 365)
    : 90; // "all" — default to 90 days to keep the chart readable
  const scansPerDay: { date: string; count: number }[] = [];
  const todayMid = new Date();
  const today = new Date(todayMid.getFullYear(), todayMid.getMonth(), todayMid.getDate());
  for (let i = rangeDays - 1; i >= 0; i--) {
    const ds = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    scansPerDay.push({ date: ds, count: perDay.get(ds) ?? 0 });
  }

  return {
    kpis: {
      totalScans: Number(k.total_scans ?? 0),
      totalArbsFound: Number(k.total_arbs ?? 0),
      activeArbs: Number(k.active_arbs ?? 0),
      avgRoi: Number(k.avg_roi ?? 0),
      marketsTracked: Number(k.markets_tracked ?? 0),
      totalProfit: Number(k.total_profit ?? 0),
    },
    scansPerDay,
    roiBuckets: bucketDefs.map((d, i) => ({ ...d, count: Number(bucketRow[`b${i}`] ?? 0) })),
    timeline: (hourRes.rows as any[]).map((r) => ({
      time: r.hour,
      scans: Number(r.scans),
      avgRoi: +Number(r.avg_roi ?? 0).toFixed(2),
    })),
    profitTimeline: (profitRes.rows as any[]).map((r) => ({
      time: r.hour,
      profit: +Number(r.profit ?? 0).toFixed(2),
    })),
    // topActiveArbs moved to stats route (computed from savedMarkets)
    recurringArbs: Number((recurRes.rows as any[])[0]?.cnt ?? 0),
    vanishedArbs: Number((vanishedRes.rows as any[])[0]?.cnt ?? 0),
    arbTypeBreakdown: (arbTypeRes.rows as any[]).map((r) => ({
      type: r.arb_type,
      count: Number(r.cnt ?? 0),
      totalProfit: +Number(r.total_profit ?? 0).toFixed(2),
      avgRoi: +Number(r.avg_roi ?? 0).toFixed(2),
    })),
  };
}

/* ─────────────────────────── Rate Limiter Metrics (UI-033) ───── */

export interface RateLimiterMetricRecord {
  id?: number;
  limiterName: string;
  timestamp: string;
  totalRequests: number;
  queuedRequests: number;
  rejectedRequests: number;
  retry429Count: number;
  avgQueueWaitMs: number;
  tokensAvailable: number;
  isThrottled: boolean;
  effectiveRate: number;
  refillIntervalMs: number;
}

/** Persist one snapshot row per limiter. */
export async function persistRateLimiterMetrics(records: RateLimiterMetricRecord[]): Promise<void> {
  await ensureDb();
  const c = getClient();
  const insert = await c.batch(
    records.map((r) => ({
      sql: `INSERT INTO rate_limiter_metrics
              (limiter_name, timestamp, total_requests, queued_requests, rejected_requests,
               retry_429_count, avg_queue_wait_ms, tokens_available, is_throttled,
               effective_rate, refill_interval_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        r.limiterName,
        r.timestamp,
        r.totalRequests ?? 0,
        r.queuedRequests ?? 0,
        r.rejectedRequests ?? 0,
        r.retry429Count ?? 0,
        r.avgQueueWaitMs ?? 0,
        r.tokensAvailable ?? 0,
        r.isThrottled ? 1 : 0,
        r.effectiveRate ?? 0,
        r.refillIntervalMs ?? 0,
      ],
    })),
    'write',
  );
  // Defensive: libsql batch returns an array of results; swallow so callers don't await them
  void insert;
}

/**
 * UI-033: hourly capacity utilization per limiter, SQL-side aggregation.
 * Returns one row per (hour, limiter) with utilization % = total_requests /
 * theoretical max for that hour (3600 * 1000 / refill_interval_ms).
 * Rows are ordered newest first.
 */
export async function getCapacityUtilization(since?: string): Promise<{
  hour: string;
  limiter: string;
  utilizationPct: number;
  totalRequests: number;
  maxRequests: number;
  isThrottled: number;
  avgQueueWaitMs: number;
  rejectedRequests: number;
}[]> {
  await ensureDb();
  const c = getClient();
  const where = since ? 'WHERE timestamp >= ?' : 'WHERE 1=1';
  const args: (string | number)[] = since ? [since] : [];
  const res = await c.execute({
    sql: `SELECT
            substr(timestamp, 1, 13) || ':00:00' AS hour,
            limiter_name                            AS limiter,
            refill_interval_ms                      AS refill_interval_ms,
            SUM(total_requests)                     AS total_requests,
            MAX(CASE WHEN is_throttled = 1 THEN 1 ELSE 0 END) AS was_throttled,
            AVG(avg_queue_wait_ms)                  AS avg_queue_wait_ms,
            SUM(rejected_requests)                  AS rejected_requests
          FROM rate_limiter_metrics
          ${where}
          GROUP BY hour, limiter_name
          ORDER BY hour DESC, limiter_name`,
    args,
  });
  const rows = Array.isArray(res.rows) ? (res.rows as any[]) : [];
  return rows.map((r) => {
    const totalRequests = Number(r.total_requests ?? 0);
    const refillIntervalMs = Math.max(1, Number(r.refill_interval_ms ?? 1000));
    const maxRequests = Math.round((3600 * 1000) / refillIntervalMs);
    return {
      hour: String(r.hour),
      limiter: String(r.limiter),
      utilizationPct: +Math.min(100, (totalRequests / Math.max(1, maxRequests)) * 100).toFixed(2),
      totalRequests,
      maxRequests,
      isThrottled: Number(r.was_throttled ?? 0),
      avgQueueWaitMs: Math.round(Number(r.avg_queue_wait_ms ?? 0)),
      rejectedRequests: Number(r.rejected_requests ?? 0),
    };
  });
}

export interface LastScanResult {
  bestRoiPct: number;      // t.ex. 26.5 (for backward compat / display)
  bestProfit: number;       // t.ex. 265
  strategy: string;         // "Buy YES Kalshi + NO PM"
  arbType?: string | null;
  outcomeCount: number;
  matchedCount: number;
  kalshiCount: number;
  pmCount: number;
  scannedAt: string | null; // ISO timestamp; null means never authoritatively scanned
  matchStatus?: 'not_scanned' | 'refreshing' | 'unavailable' | 'confirmed_zero' | 'matched';
  matchError?: string;
  matchedPairs?: { artist: string; kalshiTicker: string; pmConditionId: string }[];
  matchDependencies?: import('./coupling-store').CouplingDependency[];
  publicationGeneration?: number;
  category?: string;        // market domain classification (e.g. politics, sports)
  pmClosed?: boolean;       // UI-013: PM reports market closed (endDate may still be future)
  priceResolved?: boolean;  // BUG-05b: at least one outcome at 99/1 extremes (true market resolution)
  allArbs?: {               // ALL positive arbitrage opportunities in this scan
    artist: string;
    roiPct: number;
    expectedProfit: number;
    strategy: string;
    arbType?: string;
    totalStake?: number;
    // Price fields for cached detail view rendering (UI: no empty "Refreshing prices")
    kalshiTicker?: string;
    kalshiYesAsk?: number;
    kalshiNoAsk?: number;
    kalshiYesBid?: number;
    kalshiNoBid?: number;
    kalshiYesDepth?: number | string | null;
    kalshiNoDepth?: number | string | null;
    pmConditionId?: string;
    pmYesPrice?: number;
    pmNoPrice?: number;
    pmBestBid?: number;
    pmBestAsk?: number;
    pmYesDepth?: number | null;
    pmNoDepth?: number | null;
    kalshiStake?: number;
    pmStake?: number;
    apyPct?: number;
    buyPlatform?: string | null;
    buyPrice?: number;
    sellPlatform?: string | null;
    sellPrice?: number;
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
  arbType?: 'cross' | 'direct' | 'internal' | null;
}

export interface SavedMarket {
  id: string;
  kalshiUrl: string;
  polymarketUrl: string;
  /** Canonical N-platform representation; legacy URLs remain during migration. */
  platformLinks?: MarketLink[];
  eventTitle: string;
  category?: string; // e.g. "Politics", "Temperature", "Finances", "Mentions", "Sports"
  createdAt: string;
  expiryDate?: string | null; // ISO timestamp
  favorite?: boolean;         // user-starred for quick access
  lastScanResult?: LastScanResult | null;
  /** WS-107: real-time result from the ws-watcher (HOT pairs only). UI reads
   *  liveResult ?? lastScanResult. Core fields required, rest optional so the
   *  client-side SavedMarket (page-shared.ts) stays structurally assignable. */
  liveResult?: (Pick<LastScanResult, 'bestRoiPct' | 'bestProfit' | 'strategy' | 'scannedAt'> & Partial<LastScanResult>) | null;
  // AUTO-002: lifecycle
  archived?: boolean;
  archivedAt?: string | null;
  archiveReason?: string | null;   // 'expired' | 'dead' | 'manual'
  lastMatchedAt?: string | null;   // last scan with matchedCount > 0
}

async function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

// ── OPS-009: SQLite-backed saved markets ──────────────────────────
// The DB is the source of truth. A JSON mirror of saved-markets.json is
// written best-effort after each mutation so the poller (read-only) and
// any legacy tooling keep working, and so a rollback is one file-copy away.

function legacyPlatformLinks(kalshiUrl: string, polymarketUrl: string): MarketLink[] {
  return [
    { platform: 'kalshi', url: kalshiUrl },
    { platform: 'polymarket', url: polymarketUrl },
  ];
}

function parsePlatformLinks(value: unknown, kalshiUrl: string, polymarketUrl: string): MarketLink[] {
  try {
    const parsed = value ? JSON.parse(String(value)) : null;
    if (Array.isArray(parsed) && parsed.every(link => typeof link?.url === 'string' && typeof link?.platform === 'string')) {
      return parsed as MarketLink[];
    }
  } catch { /* fall back to legacy URLs */ }
  return legacyPlatformLinks(kalshiUrl, polymarketUrl);
}

function rowToMarket(r: any): SavedMarket {
  let lastScanResult: LastScanResult | null = null;
  try { lastScanResult = r.last_scan_result ? JSON.parse(String(r.last_scan_result)) : null; } catch {}
  let liveResult: LastScanResult | null = null;
  try { liveResult = r.live_result ? JSON.parse(String(r.live_result)) : null; } catch {}
  lastScanResult = sanitizeSavedArbResult(lastScanResult);
  liveResult = sanitizeSavedArbResult(liveResult);
  // WS-107: a live result is only trustworthy while the watcher is actively
  // recomputing it. If it's older than the TTL (watcher down, pair left HOT
  // tier), drop it so the UI falls back to the poller's lastScanResult.
  if (liveResult?.scannedAt) {
    const age = Date.now() - new Date(liveResult.scannedAt).getTime();
    if (!(age >= 0 && age <= LIVE_RESULT_TTL_MS)) liveResult = null;
  } else {
    liveResult = null;
  }
  const kalshiUrl = String(r.kalshi_url);
  const polymarketUrl = String(r.polymarket_url);
  return {
    id: String(r.id),
    kalshiUrl,
    polymarketUrl,
    platformLinks: parsePlatformLinks(r.platform_links, kalshiUrl, polymarketUrl),
    eventTitle: String(r.event_title ?? ''),
    category: r.category != null ? String(r.category) : undefined,
    createdAt: String(r.created_at),
    expiryDate: r.expiry_date != null ? String(r.expiry_date) : null,
    favorite: Boolean(Number(r.favorite ?? 0)),
    lastScanResult,
    liveResult,
    archived: Boolean(Number(r.archived ?? 0)),
    archivedAt: r.archived_at != null ? String(r.archived_at) : null,
    archiveReason: r.archive_reason != null ? String(r.archive_reason) : null,
    lastMatchedAt: r.last_matched_at != null ? String(r.last_matched_at) : null,
  };
}

function sanitizeSavedArbResult(result: LastScanResult | null): LastScanResult | null {
  if (!result) return null;
  const allArbs = (result.allArbs ?? []).filter((candidate) => {
    const declared = candidate.arbType === 'cross' || candidate.arbType === 'direct' || candidate.arbType === 'internal'
      ? candidate.arbType : null;
    const audit = auditArbClassification(candidate.strategy, declared);
    return audit.valid && audit.canonicalType !== null;
  });
  const topAudit = auditArbClassification(result.strategy, result.arbType ?? null);
  if (topAudit.valid && topAudit.canonicalType !== null) return { ...result, allArbs };
  const best = allArbs.reduce<(typeof allArbs)[number] | null>(
    (current, candidate) => !current || candidate.roiPct > current.roiPct ? candidate : current,
    null,
  );
  return {
    ...result,
    bestRoiPct: best?.roiPct ?? 0,
    bestProfit: best?.expectedProfit ?? 0,
    strategy: best?.strategy ?? 'No arb',
    arbType: best?.arbType === 'cross' || best?.arbType === 'direct' || best?.arbType === 'internal' ? best.arbType : null,
    allArbs,
  };
}

async function upsertMarketRow(m: SavedMarket): Promise<void> {
  const c = getClient();
  await c.execute({
    sql: `INSERT INTO saved_markets
            (id, kalshi_url, polymarket_url, platform_links, event_title, category, created_at, expiry_date, favorite, last_scan_result,
             archived, archived_at, archive_reason, last_matched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kalshi_url = excluded.kalshi_url,
            polymarket_url = excluded.polymarket_url,
            platform_links = excluded.platform_links,
            event_title = excluded.event_title,
            category = excluded.category,
            expiry_date = excluded.expiry_date,
            favorite = excluded.favorite,
            last_scan_result = excluded.last_scan_result,
            archived = excluded.archived,
            archived_at = excluded.archived_at,
            archive_reason = excluded.archive_reason,
            last_matched_at = excluded.last_matched_at`,
    args: [
      m.id, m.kalshiUrl, m.polymarketUrl,
      JSON.stringify(m.platformLinks ?? legacyPlatformLinks(m.kalshiUrl, m.polymarketUrl)),
      m.eventTitle, m.category ?? null,
      m.createdAt, m.expiryDate ?? null, m.favorite ? 1 : 0,
      m.lastScanResult ? JSON.stringify(m.lastScanResult) : null,
      m.archived ? 1 : 0, m.archivedAt ?? null, m.archiveReason ?? null, m.lastMatchedAt ?? null,
    ],
  });
  invalidateMarketsCache();
}

// One-time migration: import JSON file into SQLite if table is empty.
let _marketsMigrated = false;
async function ensureMarketsMigrated(): Promise<void> {
  if (_marketsMigrated) return;
  await ensureDb();
  const c = getClient();
  // FEAT-3: backfill the canonical N-platform field before any caller reads it.
  const legacyRows = await c.execute('SELECT id, kalshi_url, polymarket_url FROM saved_markets WHERE platform_links IS NULL OR platform_links = \'\'');
  for (const row of legacyRows.rows as any[]) {
    const kalshiUrl = String(row.kalshi_url);
    const polymarketUrl = String(row.polymarket_url);
    await c.execute({
      sql: 'UPDATE saved_markets SET platform_links = ? WHERE id = ?',
      args: [JSON.stringify(legacyPlatformLinks(kalshiUrl, polymarketUrl)), String(row.id)],
    });
  }
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

// PERF-P1: throttled mirror for high-frequency scan-result writes.
// Every scan used to trigger a full DB read + 745KB JSON rewrite. The poller
// (the JSON's only freshness-sensitive reader) wakes every 60s, so mirroring
// at most once per 60s — with a trailing write so the last update always
// lands — is lossless for consumers and eliminates ~95% of mirror I/O.
const MIRROR_THROTTLE_MS = 60_000;
let _lastMirrorAt = 0;
let _mirrorTimer: ReturnType<typeof setTimeout> | null = null;
function mirrorMarketsToJsonThrottled(): void {
  const now = Date.now();
  if (now - _lastMirrorAt >= MIRROR_THROTTLE_MS) {
    _lastMirrorAt = now;
    void mirrorMarketsToJson();
    return;
  }
  if (_mirrorTimer) return; // trailing write already scheduled
  const delay = MIRROR_THROTTLE_MS - (now - _lastMirrorAt);
  _mirrorTimer = setTimeout(() => {
    _mirrorTimer = null;
    _lastMirrorAt = Date.now();
    void mirrorMarketsToJson();
  }, delay);
  // Don't keep the process alive just for a pending mirror
  if (typeof (_mirrorTimer as any)?.unref === 'function') (_mirrorTimer as any).unref();
}

// PERF-P3: micro-cache for getSavedMarkets — it runs SELECT * over 526 rows
// (with JSON blobs) on nearly every API request. 5s TTL, invalidated on any
// write. Poller/watcher freshness is unaffected (they act on ≥60s cycles).
let _marketsCache: { data: SavedMarket[]; at: number; includeArchived: boolean } | null = null;
const MARKETS_CACHE_TTL_MS = 5_000;
function invalidateMarketsCache(): void { _marketsCache = null; }

export async function getSavedMarkets(opts?: { includeArchived?: boolean }): Promise<SavedMarket[]> {
  const includeArchived = !!opts?.includeArchived;
  const now = Date.now();
  if (_marketsCache && _marketsCache.includeArchived === includeArchived && now - _marketsCache.at < MARKETS_CACHE_TTL_MS) {
    return _marketsCache.data;
  }
  await ensureMarketsMigrated();
  const c = getClient();
  const where = includeArchived ? '' : 'WHERE archived = 0';
  const res = await c.execute(`SELECT * FROM saved_markets ${where} ORDER BY created_at ASC`);
  const data = (res.rows as any[]).map(rowToMarket);
  _marketsCache = { data, at: now, includeArchived };
  return data;
}

/** PERF-P1: targeted lookup by exact URL pair — avoids loading all markets. */
export async function findSavedMarketByUrls(kalshiUrl: string, polymarketUrl: string): Promise<SavedMarket | null> {
  await ensureMarketsMigrated();
  const c = getClient();
  const res = await c.execute({
    sql: 'SELECT * FROM saved_markets WHERE kalshi_url = ? AND polymarket_url = ? AND archived = 0 LIMIT 1',
    args: [kalshiUrl, polymarketUrl],
  });
  const rows = res.rows as any[];
  return rows.length > 0 ? rowToMarket(rows[0]) : null;
}

/** AUTO-002: archived markets only (newest archive first). */
export async function getArchivedMarkets(): Promise<SavedMarket[]> {
  await ensureMarketsMigrated();
  const c = getClient();
  const res = await c.execute('SELECT * FROM saved_markets WHERE archived = 1 ORDER BY archived_at DESC');
  return (res.rows as any[]).map(rowToMarket);
}

/** AUTO-002: archive a market (excluded from polling + JSON mirror). */
export async function archiveSavedMarket(id: string, reason: string): Promise<boolean> {
  await ensureMarketsMigrated();
  const c = getClient();
  const res = await c.execute({
    sql: 'UPDATE saved_markets SET archived = 1, archived_at = ?, archive_reason = ? WHERE id = ? AND archived = 0',
    args: [new Date().toISOString(), reason, id],
  });
  invalidateMarketsCache();
  const changed = Number((res as any).rowsAffected ?? 0) > 0;
  if (changed) await mirrorMarketsToJson();
  return changed;
}

/** AUTO-002: restore an archived market back into the active watchlist. */
export async function unarchiveSavedMarket(id: string): Promise<boolean> {
  await ensureMarketsMigrated();
  const c = getClient();
  const res = await c.execute({
    sql: 'UPDATE saved_markets SET archived = 0, archived_at = NULL, archive_reason = NULL WHERE id = ? AND archived = 1',
    args: [id],
  });
  invalidateMarketsCache();
  const changed = Number((res as any).rowsAffected ?? 0) > 0;
  if (changed) await mirrorMarketsToJson();
  return changed;
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
    id: crypto.randomUUID(),
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
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    lastScanResult: input.lastScanResult ?? null,
  };
  await upsertMarketRow(newMarket);
  await mirrorMarketsToJson();
  return newMarket;
}

function matchPublicationAuthority(result: LastScanResult): number {
  return result.matchStatus === 'refreshing' ? 0 : result.matchStatus === 'unavailable' ? 1 : 2;
}

function isStaleMatchPublication(previous: LastScanResult | null, incoming: LastScanResult): boolean {
  if (incoming.publicationGeneration != null && previous?.publicationGeneration != null
    && incoming.publicationGeneration !== previous.publicationGeneration) {
    return incoming.publicationGeneration < previous.publicationGeneration;
  }
  if (!previous?.scannedAt || !incoming.scannedAt) return false;
  if (incoming.scannedAt !== previous.scannedAt) return incoming.scannedAt < previous.scannedAt;
  return matchPublicationAuthority(incoming) < matchPublicationAuthority(previous);
}

export type SavedMarketPublicationChannel = 'scan' | 'live';

/** Reserve a producer generation before network work begins. */
export async function reserveSavedMarketPublication(
  id: string,
  channel: SavedMarketPublicationChannel,
): Promise<number> {
  await ensureMarketsMigrated();
  return withSqliteBusyRetry(async () => {
    const column = channel === 'scan' ? 'scan_publication_generation' : 'live_publication_generation';
    const c = getClient();
    const tx = await c.transaction('write');
    try {
      const updated = await tx.execute({
        sql: `UPDATE saved_markets SET ${column} = ${column} + 1 WHERE id = ? RETURNING ${column}`,
        args: [id],
      });
      if (!updated.rows[0]) throw new Error(`Saved market ${id} not found while reserving ${channel} publication`);
      const generation = Number(updated.rows[0][column]);
      await tx.commit();
      return generation;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  });
}

export async function updateSavedMarketScanResult(id: string, result: LastScanResult, expiryDate?: string | null): Promise<boolean> {
  // Targeted UPDATE — no read-modify-write of the whole list. This was the
  // main race: concurrent scans clobbering each other's lastScanResult.
  await ensureMarketsMigrated();
  const c = getClient();
  const tx = await c.transaction('write');
  try {
    const current = await tx.execute({
      sql: 'SELECT last_scan_result, scan_publication_generation FROM saved_markets WHERE id = ?', args: [id],
    });
    if (!current.rows[0]) { await tx.rollback(); return false; }
    const previous = current.rows[0].last_scan_result
      ? JSON.parse(String(current.rows[0].last_scan_result)) as LastScanResult
      : null;
    if (result.publicationGeneration != null
      && result.publicationGeneration !== Number(current.rows[0].scan_publication_generation)) {
      await tx.rollback();
      return false;
    }
    if (isStaleMatchPublication(previous, result)) {
      await tx.rollback();
      return false;
    }
    const prepared = await prepareCanonicalMatchResult(result, previous, 'saved_market_scan', tx);
    if (!prepared) { await tx.rollback(); return false; }
    const matchedNow = prepared.matchedCount > 0 ? new Date().toISOString() : null;
    await tx.execute({
      sql: `UPDATE saved_markets SET last_scan_result = ?,
              expiry_date = CASE WHEN ? THEN ? ELSE expiry_date END,
              last_matched_at = COALESCE(?, last_matched_at) WHERE id = ?`,
      args: [JSON.stringify(prepared), expiryDate !== undefined ? 1 : 0, expiryDate ?? null, matchedNow, id],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
  invalidateMarketsCache();
  mirrorMarketsToJsonThrottled();
  return true;
}

/** Restart recovery for scans whose worker process disappeared after publishing
 * `refreshing`. A newer generation fences any late publisher. */
export async function recoverInterruptedScanPublications(staleAfterMs = 120_000): Promise<number> {
  await ensureMarketsMigrated();
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - Math.max(1_000, staleAfterMs)).toISOString();
  const result = await withSqliteBusyRetry(() => getClient().execute({
    sql: `UPDATE saved_markets
          SET scan_publication_generation = scan_publication_generation + 1,
              last_scan_result = json_set(last_scan_result,
                '$.matchStatus', 'unavailable',
                '$.matchError', 'Recovered interrupted scan after application restart',
                '$.scannedAt', ?,
                '$.publicationGeneration', scan_publication_generation + 1)
          WHERE json_extract(last_scan_result, '$.matchStatus') = 'refreshing'
            AND json_extract(last_scan_result, '$.scannedAt') < ?`,
    args: [now, cutoff],
  }));
  if (result.rowsAffected > 0) {
    invalidateMarketsCache();
    mirrorMarketsToJsonThrottled();
  }
  return result.rowsAffected;
}

async function prepareCanonicalMatchResult(
  incoming: LastScanResult,
  previous: LastScanResult | null,
  source: string,
  executor: import('./coupling-store').CouplingExecutor,
): Promise<LastScanResult | null> {
  incoming = sanitizeSavedArbResult(incoming) ?? incoming;
  if (incoming.matchStatus === 'unavailable' || incoming.matchStatus === 'refreshing') {
    return {
      ...(previous ?? incoming),
      matchStatus: incoming.matchStatus,
      matchError: incoming.matchError,
      scannedAt: incoming.scannedAt,
      publicationGeneration: incoming.publicationGeneration,
      matchedCount: previous?.matchedCount ?? incoming.matchedCount,
      matchedPairs: previous?.matchedPairs ?? incoming.matchedPairs ?? [],
      matchDependencies: previous?.matchDependencies,
    };
  }
  const pairs = incoming.matchedPairs ?? [];
  if (pairs.length === 0) {
    // Legacy producers did not persist stable pair ids. Preserve their count;
    // new producers that explicitly publish confirmed zero remain true zero.
    return incoming.matchedCount > 0 && incoming.matchedPairs === undefined
      ? incoming
      : { ...incoming, matchedCount: 0, matchedPairs: [], matchDependencies: [] };
  }
  const store = await import('./coupling-store');
  const dependencies = incoming.matchDependencies;
  if (dependencies) {
    if (dependencies.length !== pairs.length || !await store.areCouplingDependenciesEligible(dependencies, executor)) return null;
  } else {
    const captured = await store.captureCouplingDependenciesWithExecutor(pairs, source, executor);
    if (captured.length !== pairs.length) return null;
    return { ...incoming, matchedCount: pairs.length, matchedPairs: pairs, matchDependencies: captured };
  }
  return { ...incoming, matchedCount: pairs.length, matchedPairs: pairs, matchDependencies: dependencies };
}

let matchSummaryBackfillComplete = false;

/** Idempotent restart/list reconciliation for legacy summaries that predate
 * stable pair identities and coupling revisions. This never invents pairs:
 * only already-persisted canonical pair ids are versioned. */
export async function reconcileSavedMarketMatchSummaries(): Promise<number> {
  if (matchSummaryBackfillComplete) return 0;
  await ensureMarketsMigrated();
  const c = getClient();
  const rows = await c.execute(`SELECT id, last_scan_result FROM saved_markets
    WHERE archived = 0 AND last_scan_result IS NOT NULL
      AND json_array_length(COALESCE(json_extract(last_scan_result, '$.matchedPairs'), '[]')) > 0
      AND json_extract(last_scan_result, '$.matchDependencies') IS NULL`);
  let reconciled = 0;
  for (const row of rows.rows) {
    let result: LastScanResult;
    try { result = JSON.parse(String(row.last_scan_result)); } catch { continue; }
    const before = JSON.stringify(result.matchDependencies ?? null);
    await updateSavedMarketScanResult(String(row.id), result);
    const updated = await getSavedMarketById(String(row.id));
    if (JSON.stringify(updated?.lastScanResult?.matchDependencies ?? null) !== before) reconciled++;
  }
  matchSummaryBackfillComplete = true;
  return reconciled;
}

export async function reconcileSavedMarketMatchSummary(
  id: string,
  summary: Pick<LastScanResult, 'matchedCount' | 'matchStatus' | 'matchError' | 'matchedPairs' | 'matchDependencies' | 'scannedAt' | 'publicationGeneration'>,
): Promise<void> {
  const fallback: LastScanResult = {
    bestRoiPct: 0, bestProfit: 0, strategy: 'No arb', outcomeCount: summary.matchedCount,
    kalshiCount: 0, pmCount: 0, allArbs: [], ...summary,
  };
  await updateSavedMarketScanResult(id, fallback);
}

// WS-107: watcher-written real-time result ─────────────────────────
/** How long a liveResult stays valid without a fresh watcher write. */
export const DEFAULT_LIVE_RESULT_TTL_MS = 10 * 60_000;

/**
 * Keep stale watcher output from becoming permanently valid if deployment
 * configuration contains a malformed TTL (for example `Infinity` or `0`).
 */
export function parseLiveResultTtlMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_LIVE_RESULT_TTL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIVE_RESULT_TTL_MS;
}

export const LIVE_RESULT_TTL_MS = parseLiveResultTtlMs(process.env.H2H_LIVE_RESULT_TTL_MS);

/** WS-107: persist the watcher's real-time computation for a HOT market.
 *  Targeted UPDATE of live_result only — never touches last_scan_result, so
 *  the REST poller and the watcher can't clobber each other.
 *  Skips the JSON mirror by design: live writes are frequent and the mirror
 *  (poller input) should stay driven by poller-cadence scans. */
export async function updateSavedMarketLiveResult(id: string, result: LastScanResult): Promise<void> {
  await ensureMarketsMigrated();
  const c = getClient();
  const tx = await c.transaction('write');
  try {
    const current = await tx.execute({
      sql: 'SELECT live_result, live_publication_generation FROM saved_markets WHERE id = ?', args: [id],
    });
    if (!current.rows[0]) { await tx.rollback(); return; }
    const previous = current.rows[0].live_result
      ? JSON.parse(String(current.rows[0].live_result)) as LastScanResult
      : null;
    if (result.publicationGeneration != null
      && result.publicationGeneration !== Number(current.rows[0].live_publication_generation)) {
      await tx.rollback();
      return;
    }
    if (isStaleMatchPublication(previous, result)) {
      await tx.rollback();
      return;
    }
    const prepared = await prepareCanonicalMatchResult(result, previous, 'saved_market_live', tx);
    if (!prepared) { await tx.rollback(); return; }
    const matchedNow = prepared.matchedCount > 0 ? new Date().toISOString() : null;
    await tx.execute({
      sql: 'UPDATE saved_markets SET live_result = ?, last_matched_at = COALESCE(?, last_matched_at) WHERE id = ?',
      args: [JSON.stringify(prepared), matchedNow, id],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
  invalidateMarketsCache();
}

/** WS-107: clear a market's live result (pair left HOT tier / watcher shutdown). */
export async function clearSavedMarketLiveResult(id: string): Promise<void> {
  await ensureMarketsMigrated();
  const c = getClient();
  await c.execute({ sql: 'UPDATE saved_markets SET live_result = NULL WHERE id = ?', args: [id] });
  invalidateMarketsCache();
}

export async function getSavedMarketById(id: string): Promise<SavedMarket | null> {
  await ensureMarketsMigrated();
  const c = getClient();
  const res = await c.execute({
    sql: 'SELECT * FROM saved_markets WHERE id = ? AND archived = 0 LIMIT 1',
    args: [id],
  });
  const rows = res.rows as any[];
  return rows.length > 0 ? rowToMarket(rows[0]) : null;
}

export async function updateSavedMarket(
  id: string,
  updates: Partial<Pick<SavedMarket, 'eventTitle' | 'expiryDate' | 'category' | 'kalshiUrl' | 'polymarketUrl' | 'platformLinks'>>,
): Promise<boolean> {
  await ensureMarketsMigrated();
  const c = getClient();
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (updates.eventTitle !== undefined) { sets.push('event_title = ?'); args.push(updates.eventTitle); }
  if (updates.expiryDate !== undefined) { sets.push('expiry_date = ?'); args.push(updates.expiryDate || null); }
  if (updates.category !== undefined) { sets.push('category = ?'); args.push(updates.category); }
  if (updates.kalshiUrl !== undefined) { sets.push('kalshi_url = ?'); args.push(updates.kalshiUrl); }
  if (updates.polymarketUrl !== undefined) { sets.push('polymarket_url = ?'); args.push(updates.polymarketUrl); }
  if (updates.platformLinks !== undefined) { sets.push('platform_links = ?'); args.push(JSON.stringify(updates.platformLinks)); }
  if (sets.length === 0) return false;
  args.push(id);
  const res = await c.execute({ sql: `UPDATE saved_markets SET ${sets.join(', ')} WHERE id = ?`, args });
  invalidateMarketsCache();
  const changed = Number((res as any).rowsAffected ?? 0) > 0;
  if (changed) await mirrorMarketsToJson();
  return changed;
}

export async function deleteSavedMarket(id: string): Promise<boolean> {
  await ensureMarketsMigrated();
  const c = getClient();
  const res = await c.execute({ sql: 'DELETE FROM saved_markets WHERE id = ?', args: [id] });
  invalidateMarketsCache();
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
  await withSqliteBusyRetry(async () => {
    await c.execute({
      sql: `INSERT INTO scan_history (scan_timestamp, market_id, total_profit, best_roi_pct, positive_arb_count, matched_count)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [entry.scanTimestamp, entry.marketId, entry.totalProfit ?? 0, entry.bestRoiPct ?? 0, entry.positiveArbCount ?? 0, entry.matchedCount ?? 0],
    });
    // Bounded: keep the most recent 5000 rows (was 500 in JSON — cheap in SQLite)
    await c.execute(`DELETE FROM scan_history WHERE id NOT IN (SELECT id FROM scan_history ORDER BY scan_timestamp DESC LIMIT 5000)`);
  });
}


// ─── TRADES-001: persistent execution log ─────────────────────────
// auto-execute's in-memory auditLog is lost on every pm2 restart; this
// table is the durable record backing the Trades page.

let _executionsReady = false;
async function ensureExecutionsTable(): Promise<void> {
  if (_executionsReady) return;
  const c = getClient();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS executions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp        TEXT    NOT NULL,
      arb_id           TEXT    NOT NULL,
      market_title     TEXT    NOT NULL,
      dry_run          INTEGER NOT NULL DEFAULT 1,
      success          INTEGER NOT NULL DEFAULT 0,
      strategy         TEXT,
      kalshi_order     TEXT,
      polymarket_order TEXT,
      result           TEXT,
      estimated_profit REAL    NOT NULL DEFAULT 0,
      steps            TEXT,
      selection_method TEXT CHECK (selection_method IN ('roi', 'apy', 'hybrid') OR selection_method IS NULL)
    )`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_executions_ts ON executions(timestamp DESC)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_executions_arb_id ON executions(arb_id)`);
  // Migration: add steps column if missing (existing DBs)
  try { await c.execute(`ALTER TABLE executions ADD COLUMN steps TEXT`); } catch { /* column already exists */ }
  // FEAT-040: add source column for manual vs bot execution tracking
  try { await c.execute(`ALTER TABLE executions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`); } catch { /* column already exists */ }
  // DATA-003: immutable attribution captured when BotTrader selects a trade.
  // Existing rows remain NULL: historical intent must never be guessed.
  try { await c.execute(`ALTER TABLE executions ADD COLUMN selection_method TEXT`); } catch { /* column already exists */ }
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_executions_selection_method ON executions(selection_method, timestamp DESC)`);
  _executionsReady = true;
}

export interface ExecutionRecord {
  id?: number;
  timestamp: string;
  arbId: string;
  marketTitle: string;
  dryRun: boolean;
  success: boolean;
  strategy?: string | null;
  kalshiOrder?: unknown;
  polymarketOrder?: unknown;
  result?: unknown;
  estimatedProfit: number;
  steps?: unknown;
  source?: 'manual' | 'bot';
  selectionMethod?: 'roi' | 'apy' | 'hybrid' | null;
}

export async function persistExecution(e: ExecutionRecord): Promise<number> {
  await ensureExecutionsTable();
  const c = getClient();
  const res = await c.execute({
    sql: `INSERT INTO executions (timestamp, arb_id, market_title, dry_run, success, strategy, kalshi_order, polymarket_order, result, estimated_profit, steps, source, selection_method)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id`,
    args: [
      e.timestamp, e.arbId, e.marketTitle, e.dryRun ? 1 : 0, e.success ? 1 : 0,
      e.strategy ?? null,
      e.kalshiOrder != null ? JSON.stringify(e.kalshiOrder) : null,
      e.polymarketOrder != null ? JSON.stringify(e.polymarketOrder) : null,
      e.result != null ? JSON.stringify(e.result) : null,
      e.estimatedProfit ?? 0,
      e.steps != null ? JSON.stringify(e.steps) : null,
      e.source ?? 'manual',
      e.source === 'bot' ? (e.selectionMethod ?? null) : null,
    ],
  });
  return Number((res.rows as any[])[0]?.id ?? 0);
}

export async function getExecutions(
  limit = 200,
  source?: 'manual' | 'bot',
  options: { selectionMethod?: 'roi' | 'apy' | 'hybrid' | 'legacy'; sortMethod?: 'asc' | 'desc' } = {},
): Promise<ExecutionRecord[]> {
  await ensureExecutionsTable();
  const c = getClient();
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  if (source) { clauses.push('source = ?'); args.push(source); }
  if (options.selectionMethod === 'legacy') clauses.push('selection_method IS NULL');
  else if (options.selectionMethod) { clauses.push('selection_method = ?'); args.push(options.selectionMethod); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const order = options.sortMethod
    ? `CASE WHEN selection_method IS NULL THEN 1 ELSE 0 END, selection_method ${options.sortMethod === 'asc' ? 'ASC' : 'DESC'}, timestamp DESC`
    : 'timestamp DESC';
  const sql = `SELECT * FROM executions ${where} ORDER BY ${order} LIMIT ?`;
  args.push(Math.min(10_000, Math.max(1, limit)));
  const res = await c.execute({ sql, args });
  return (res.rows as any[]).map((r) => rowToExecutionRecord(r));
}

function rowToExecutionRecord(r: any): ExecutionRecord {
  return {
    id: Number(r.id),
    timestamp: String(r.timestamp),
    arbId: String(r.arb_id),
    marketTitle: String(r.market_title),
    dryRun: Boolean(Number(r.dry_run)),
    success: Boolean(Number(r.success)),
    strategy: r.strategy != null ? String(r.strategy) : null,
    kalshiOrder: r.kalshi_order ? JSON.parse(String(r.kalshi_order)) : null,
    polymarketOrder: r.polymarket_order ? JSON.parse(String(r.polymarket_order)) : null,
    result: r.result ? JSON.parse(String(r.result)) : null,
    estimatedProfit: Number(r.estimated_profit ?? 0),
    steps: r.steps ? JSON.parse(String(r.steps)) : null,
    source: (r.source ?? 'manual') as 'manual' | 'bot',
    selectionMethod: r.selection_method != null ? String(r.selection_method) as 'roi' | 'apy' | 'hybrid' : null,
  };
}

/** Get a single execution by arb_id (the most recent if multiple). */
export async function getExecutionByArbId(arbId: string): Promise<ExecutionRecord | null> {
  await ensureExecutionsTable();
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT * FROM executions WHERE arb_id = ? ORDER BY timestamp DESC LIMIT 1`,
    args: [arbId],
  });
  const rows = res.rows as any[];
  if (!rows || rows.length === 0) return null;
  return rowToExecutionRecord(rows[0]);
}

/** FEAT-040: sum of bot trade exposure for today (UTC). */
export async function getTodayBotExposure(executionMode?: 'paper' | 'live'): Promise<number> {
  await ensureExecutionsTable();
  const c = getClient();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const res = await c.execute({
    sql: `SELECT COALESCE(SUM(
      CASE
        WHEN kalshi_order IS NOT NULL AND polymarket_order IS NOT NULL THEN
          COALESCE(json_extract(kalshi_order, '$.size'), 0) + COALESCE(json_extract(polymarket_order, '$.size'), 0)
        WHEN kalshi_order IS NOT NULL THEN COALESCE(json_extract(kalshi_order, '$.size'), 0)
        WHEN polymarket_order IS NOT NULL THEN COALESCE(json_extract(polymarket_order, '$.size'), 0)
        ELSE 0
      END
    ), 0) AS total FROM executions WHERE source = 'bot' ${executionMode ? 'AND dry_run = ?' : ''} AND timestamp >= ? AND timestamp < ?`,
    args: executionMode
      ? [executionMode === 'paper' ? 1 : 0, `${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`]
      : [`${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`],
  });
  return Number((res.rows as any[])[0]?.total ?? 0);
}

/** FEAT-040: check whether a bot trade already exists for this market/outcome pair. */
export async function hasOpenBotPosition(arbId: string, executionMode: 'paper' | 'live'): Promise<boolean> {
  await ensureExecutionsTable();
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT COUNT(*) AS cnt FROM executions WHERE arb_id = ? AND source = 'bot' AND success = 1 AND dry_run = ?`,
    args: [arbId, executionMode === 'paper' ? 1 : 0],
  });
  return Number((res.rows as any[])[0]?.cnt ?? 0) > 0;
}

// ─── Closed positions (trade history with full P&L) ───────────────

let _closedPositionsReady = false;
async function ensureClosedPositionsTable(): Promise<void> {
  if (_closedPositionsReady) return;
  const c = getClient();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS closed_positions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      market_title     TEXT    NOT NULL,
      platform         TEXT    NOT NULL,
      side             TEXT    NOT NULL,
      size             REAL    NOT NULL DEFAULT 0,
      entry_price      REAL    NOT NULL DEFAULT 0,
      exit_price       REAL    NOT NULL DEFAULT 0,
      realized_pnl     REAL    NOT NULL DEFAULT 0,
      roi_pct          REAL    NOT NULL DEFAULT 0,
      opened_at        TEXT,
      closed_at        TEXT    NOT NULL,
      duration_secs    INTEGER,
      pair_id          TEXT,
      fees_paid        REAL    NOT NULL DEFAULT 0,
      ticker           TEXT,
      condition_id     TEXT,
      execution_mode   TEXT    NOT NULL DEFAULT 'live',
      raw_data         TEXT
    )`);
  const columns = await c.execute(`PRAGMA table_info(closed_positions)`);
  if (!(columns.rows as any[]).some((row) => String(row.name) === 'execution_mode')) {
    await c.execute(`ALTER TABLE closed_positions ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'live'`);
  }
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_closed_positions_closed_at ON closed_positions(closed_at DESC)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_closed_positions_pair_id ON closed_positions(pair_id)`);
  _closedPositionsReady = true;
}

export interface ClosedPosition {
  id?: number;
  marketTitle: string;
  platform: 'kalshi' | 'polymarket';
  side: 'YES' | 'NO';
  size: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnl: number;
  roiPct: number;
  openedAt?: string | null;
  closedAt: string;
  durationSecs?: number | null;
  pairId?: string | null;
  feesPaid?: number;
  ticker?: string | null;
  conditionId?: string | null;
  executionMode?: 'live' | 'paper';
  rawData?: unknown;
}

export async function persistClosedPosition(cp: ClosedPosition): Promise<void> {
  await ensureClosedPositionsTable();
  const c = getClient();
  await c.execute({
    sql: `INSERT INTO closed_positions
      (market_title, platform, side, size, entry_price, exit_price, realized_pnl, roi_pct,
       opened_at, closed_at, duration_secs, pair_id, fees_paid, ticker, condition_id, execution_mode, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      cp.marketTitle, cp.platform, cp.side, cp.size,
      cp.entryPrice, cp.exitPrice, cp.realizedPnl, cp.roiPct,
      cp.openedAt ?? null, cp.closedAt,
      cp.durationSecs ?? null,
      cp.pairId ?? null,
      cp.feesPaid ?? 0,
      cp.ticker ?? null,
      cp.conditionId ?? null,
      cp.executionMode ?? 'live',
      cp.rawData != null ? JSON.stringify(cp.rawData) : null,
    ],
  });
}

export async function getClosedPositions(limit = 500): Promise<ClosedPosition[]> {
  await ensureClosedPositionsTable();
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT * FROM closed_positions ORDER BY closed_at DESC LIMIT ?`,
    args: [Math.min(5000, Math.max(1, limit))],
  });
  return (res.rows as any[]).map((r) => ({
    id: Number(r.id),
    marketTitle: String(r.market_title),
    platform: String(r.platform) as 'kalshi' | 'polymarket',
    side: String(r.side) as 'YES' | 'NO',
    size: Number(r.size),
    entryPrice: Number(r.entry_price),
    exitPrice: Number(r.exit_price),
    realizedPnl: Number(r.realized_pnl),
    roiPct: Number(r.roi_pct),
    openedAt: r.opened_at ?? null,
    closedAt: String(r.closed_at),
    durationSecs: r.duration_secs != null ? Number(r.duration_secs) : null,
    pairId: r.pair_id ?? null,
    feesPaid: Number(r.fees_paid ?? 0),
    ticker: r.ticker ?? null,
    conditionId: r.condition_id ?? null,
    executionMode: String(r.execution_mode ?? 'live') as 'live' | 'paper',
    rawData: r.raw_data ? JSON.parse(String(r.raw_data)) : undefined,
  }));
}

// ─── Market Catalog (FEAT-101) ──────────────────────────────────────

export interface MarketCatalogRow {
  id: number;
  platform: 'kalshi' | 'polymarket';
  marketId: string;
  title: string;
  category: string | null;
  eventId: string | null;
  eventTitle: string | null;
  expiryDate: string | null;
  isBinary: boolean;
  outcomeCount: number;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  volume24h: number | null;
  sourceUrl: string | null;
  fetchedAt: string;
  stale: boolean;
}

function rowToMarketCatalogRow(r: any): MarketCatalogRow {
  return {
    id: Number(r.id),
    platform: String(r.platform) as 'kalshi' | 'polymarket',
    marketId: String(r.market_id),
    title: String(r.title),
    category: r.category != null ? String(r.category) : null,
    eventId: r.event_id != null ? String(r.event_id) : null,
    eventTitle: r.event_title != null ? String(r.event_title) : null,
    expiryDate: r.expiry_date != null ? String(r.expiry_date) : null,
    isBinary: Boolean(Number(r.is_binary ?? 1)),
    outcomeCount: Number(r.outcome_count ?? 2),
    yesBid: r.yes_bid != null ? Number(r.yes_bid) : null,
    yesAsk: r.yes_ask != null ? Number(r.yes_ask) : null,
    noBid: r.no_bid != null ? Number(r.no_bid) : null,
    noAsk: r.no_ask != null ? Number(r.no_ask) : null,
    volume24h: r.volume_24h != null ? Number(r.volume_24h) : null,
    sourceUrl: r.source_url != null ? String(r.source_url) : null,
    fetchedAt: String(r.fetched_at),
    stale: Boolean(Number(r.stale ?? 0)),
  };
}

/** Ensure the market_catalog table is ready. */
async function ensureMarketCatalogTable(): Promise<void> {
  // initDb already creates the table; ensureDb guarantees initDb ran.
  await ensureDb();
}

/** Upsert a single market into the catalog. */
export async function upsertMarketCatalog(row: Omit<MarketCatalogRow, 'id' | 'stale'>): Promise<void> {
  await ensureMarketCatalogTable();
  const c = getClient();
  await c.execute({
    sql: `INSERT INTO market_catalog
            (platform, market_id, title, category, event_id, event_title, expiry_date,
             is_binary, outcome_count, yes_bid, yes_ask, no_bid, no_ask, volume_24h, source_url, fetched_at, stale)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(platform, market_id) DO UPDATE SET
            title = excluded.title,
            category = excluded.category,
            event_id = excluded.event_id,
            event_title = excluded.event_title,
            expiry_date = excluded.expiry_date,
            is_binary = excluded.is_binary,
            outcome_count = excluded.outcome_count,
            yes_bid = excluded.yes_bid,
            yes_ask = excluded.yes_ask,
            no_bid = excluded.no_bid,
            no_ask = excluded.no_ask,
            volume_24h = excluded.volume_24h,
            source_url = excluded.source_url,
            fetched_at = excluded.fetched_at,
            stale = 0`,
    args: [
      row.platform, row.marketId, row.title, row.category ?? null, row.eventId ?? null, row.eventTitle ?? null,
      row.expiryDate ?? null, row.isBinary ? 1 : 0, row.outcomeCount,
      row.yesBid ?? null, row.yesAsk ?? null, row.noBid ?? null, row.noAsk ?? null,
      row.volume24h ?? null, row.sourceUrl ?? null, row.fetchedAt, 0,
    ],
  });
}

/** Mark all rows for a platform fetched before `before` as stale. Returns rows changed. */
export async function markStaleMarketCatalog(platform: 'kalshi' | 'polymarket', before: string): Promise<number> {
  await ensureMarketCatalogTable();
  const c = getClient();
  const result = await c.execute({
    sql: `UPDATE market_catalog SET stale = 1 WHERE platform = ? AND fetched_at < ? AND stale = 0`,
    args: [platform, before],
  });
  return Number((result as any).rowsAffected ?? 0);
}

/** Query the catalog with optional platform filter, stale filter, and pagination. */
export async function queryMarketCatalog(opts: {
  platform?: 'kalshi' | 'polymarket';
  includeStale?: boolean;
  limit?: number;
  cursor?: number;
  sortBy?: 'fetched_at' | 'expiry_date' | 'title';
  sortDir?: 'asc' | 'desc';
}): Promise<{ rows: MarketCatalogRow[]; total: number; nextCursor: number | null }> {
  await ensureMarketCatalogTable();
  const c = getClient();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 10000);
  const cursor = Math.max(opts.cursor ?? 0, 0);
  const sortBy = ['fetched_at', 'expiry_date', 'title'].includes(opts.sortBy ?? '') ? opts.sortBy! : 'fetched_at';
  const sortDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';

  let where = ' WHERE 1=1';
  const args: (string | number)[] = [];
  if (opts.platform) { where += ' AND platform = ?'; args.push(opts.platform); }
  if (!opts.includeStale) { where += ' AND stale = 0'; }

  const countRes = await c.execute({ sql: `SELECT COUNT(*) AS cnt FROM market_catalog${where}`, args });
  const total = Number((countRes.rows as any[])[0]?.cnt ?? 0);

  const offsetSql = cursor > 0 ? ' OFFSET ?' : '';
  const rowsRes = await c.execute({
    sql: `SELECT * FROM market_catalog${where} ORDER BY ${sortBy} ${sortDir} LIMIT ?${offsetSql}`,
    args: cursor > 0 ? [...args, limit, cursor] : [...args, limit],
  });

  const rows = (rowsRes.rows as any[]).map(rowToMarketCatalogRow);
  const nextCursor = cursor + rows.length < total ? cursor + rows.length : null;
  return { rows, total, nextCursor };
}

/** Aggregated stats for the catalog endpoint. */

/** Alias for queryMarketCatalog for callers that expect the old name. */
export async function getMarketCatalog(opts: Parameters<typeof queryMarketCatalog>[0]): ReturnType<typeof queryMarketCatalog> {
  return queryMarketCatalog(opts);
}

/** Alias for markStaleMarketCatalog for callers that expect the old name. */
export async function pruneMarketCatalog(platform: 'kalshi' | 'polymarket', before: string): Promise<number> {
  return markStaleMarketCatalog(platform, before);
}


export async function getMarketCatalogStats(): Promise<{
  total: number;
  perPlatform: { platform: string; total: number; stale: number; lastFetchedAt: string | null }[];
}> {
  await ensureMarketCatalogTable();
  const c = getClient();
  const [totalRes, perPlatformRes] = await Promise.all([
    c.execute('SELECT COUNT(*) AS cnt FROM market_catalog'),
    c.execute(`
      SELECT platform,
             COUNT(*) AS total,
             SUM(CASE WHEN stale = 1 THEN 1 ELSE 0 END) AS stale,
             MAX(fetched_at) AS last_fetched_at
      FROM market_catalog
      GROUP BY platform
      ORDER BY platform
    `),
  ]);
  const total = Number((totalRes.rows as any[])[0]?.cnt ?? 0);
  const perPlatform = (perPlatformRes.rows as any[]).map((r) => ({
    platform: String(r.platform),
    total: Number(r.total ?? 0),
    stale: Number(r.stale ?? 0),
    lastFetchedAt: r.last_fetched_at ? String(r.last_fetched_at) : null,
  }));
  return { total, perPlatform };
}

/** Bulk insert/upsert market catalog rows in a transaction for speed. */
export async function bulkUpsertMarketCatalog(rows: Omit<MarketCatalogRow, 'id' | 'stale'>[]): Promise<number> {
  await ensureMarketCatalogTable();
  if (rows.length === 0) return 0;
  const c = getClient();
  const tx = await c.transaction('write');
  try {
    for (const row of rows) {
      await tx.execute({
        sql: `INSERT INTO market_catalog
                (platform, market_id, title, category, event_id, event_title, expiry_date,
                 is_binary, outcome_count, yes_bid, yes_ask, no_bid, no_ask, volume_24h, source_url, fetched_at, stale)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(platform, market_id) DO UPDATE SET
                title = excluded.title,
                category = excluded.category,
                event_id = excluded.event_id,
                event_title = excluded.event_title,
                expiry_date = excluded.expiry_date,
                is_binary = excluded.is_binary,
                outcome_count = excluded.outcome_count,
                yes_bid = excluded.yes_bid,
                yes_ask = excluded.yes_ask,
                no_bid = excluded.no_bid,
                no_ask = excluded.no_ask,
                volume_24h = excluded.volume_24h,
                source_url = excluded.source_url,
                fetched_at = excluded.fetched_at,
                stale = 0`,
        args: [
          row.platform, row.marketId, row.title, row.category ?? null, row.eventId ?? null, row.eventTitle ?? null,
          row.expiryDate ?? null, row.isBinary ? 1 : 0, row.outcomeCount,
          row.yesBid ?? null, row.yesAsk ?? null, row.noBid ?? null, row.noAsk ?? null,
          row.volume24h ?? null, row.sourceUrl ?? null, row.fetchedAt, 0,
        ],
      });
    }
    await tx.commit();
    return rows.length;
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

/** Clear stale flag from the most recently refreshed rows — used after a refresh completes. */
export async function touchMarketCatalog(platform: 'kalshi' | 'polymarket', fetchedAt: string): Promise<void> {
  await ensureMarketCatalogTable();
  const c = getClient();
  await c.execute({
    sql: `UPDATE market_catalog SET fetched_at = ? WHERE platform = ? AND stale = 1`,
    args: [fetchedAt, platform],
  });
}

/** Reset all stale flags (useful after schema migrations or manual repairs). */
export async function resetMarketCatalogStale(platform?: 'kalshi' | 'polymarket'): Promise<number> {
  await ensureMarketCatalogTable();
  const c = getClient();
  const result = platform
    ? await c.execute({ sql: `UPDATE market_catalog SET stale = 0 WHERE platform = ?`, args: [platform] })
    : await c.execute('UPDATE market_catalog SET stale = 0');
  return Number((result as any).rowsAffected ?? 0);
}



// ── FEAT: cross-platform matched pairs persistence ─────────────────

export interface MatchedPair {
  id: number;
  kalshiMarketId: string;
  polymarketMarketId: string;
  kalshiTitle: string | null;
  polymarketTitle: string | null;
  kalshiUrl: string | null;
  polymarketUrl: string | null;
  confidence: number;
  confidenceBreakdown: {
    nameSimilarity: number;
    entityMatch: number;
    categoryMatch: number;
    expiryProximity: number;
  };
  status: 'auto_queued' | 'pending_review' | 'approved' | 'rejected';
  matchedAt: string;
  verifiedAt: string | null;
}

function rowToMatchedPair(r: any): MatchedPair {
  let breakdown = { nameSimilarity: 0, entityMatch: 0, categoryMatch: 0, expiryProximity: 0 };
  try { breakdown = r.confidence_breakdown ? JSON.parse(String(r.confidence_breakdown)) : breakdown; } catch {}
  return {
    id: Number(r.id),
    kalshiMarketId: String(r.kalshi_market_id),
    polymarketMarketId: String(r.polymarket_market_id),
    kalshiTitle: r.kalshi_title ?? null,
    polymarketTitle: r.polymarket_title ?? null,
    kalshiUrl: r.kalshi_url ?? null,
    polymarketUrl: r.polymarket_url ?? null,
    confidence: Number(r.confidence ?? 0),
    confidenceBreakdown: breakdown,
    status: String(r.status ?? 'pending') as MatchedPair['status'],
    matchedAt: String(r.matched_at),
    verifiedAt: r.verified_at ?? null,
  };
}

async function ensureMatchedPairsTable(): Promise<void> {
  await ensureDb();
  const c = getClient();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS matched_pairs (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      kalshi_market_id       TEXT    NOT NULL,
      polymarket_market_id   TEXT    NOT NULL,
      kalshi_title           TEXT,
      polymarket_title       TEXT,
      kalshi_url             TEXT,
      polymarket_url         TEXT,
      confidence             INTEGER NOT NULL,
      confidence_breakdown   TEXT,
      status                 TEXT    DEFAULT 'pending',
      matched_at             TEXT    NOT NULL,
      verified_at            TEXT,
      UNIQUE(kalshi_market_id, polymarket_market_id)
    )
  `);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_matched_pairs_status ON matched_pairs(status, matched_at DESC)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_matched_pairs_kalshi ON matched_pairs(kalshi_market_id)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_matched_pairs_pm ON matched_pairs(polymarket_market_id)`);
}

export async function upsertMatchedPair(pair: Omit<MatchedPair, 'id'> & { id?: number }): Promise<number> {
  await ensureMatchedPairsTable();
  const c = getClient();
  const now = new Date().toISOString();
  const row = await c.execute({
    sql: `INSERT INTO matched_pairs
            (kalshi_market_id, polymarket_market_id, kalshi_title, polymarket_title, kalshi_url, polymarket_url,
             confidence, confidence_breakdown, status, matched_at, verified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(kalshi_market_id, polymarket_market_id) DO UPDATE SET
            kalshi_title = excluded.kalshi_title,
            polymarket_title = excluded.polymarket_title,
            kalshi_url = excluded.kalshi_url,
            polymarket_url = excluded.polymarket_url,
            confidence = excluded.confidence,
            confidence_breakdown = excluded.confidence_breakdown,
            status = CASE WHEN matched_pairs.status = 'approved' OR matched_pairs.status = 'rejected'
                          THEN matched_pairs.status
                          ELSE excluded.status END,
            verified_at = excluded.verified_at
          RETURNING id`,
    args: [
      pair.kalshiMarketId,
      pair.polymarketMarketId,
      pair.kalshiTitle ?? null,
      pair.polymarketTitle ?? null,
      pair.kalshiUrl ?? null,
      pair.polymarketUrl ?? null,
      pair.confidence,
      JSON.stringify(pair.confidenceBreakdown),
      pair.status,
      pair.matchedAt ?? now,
      pair.verifiedAt ?? now,
    ],
  });
  return Number((row.rows as any[])[0]?.id ?? 0);
}

export async function getMatchedPairs(status?: MatchedPair['status'] | MatchedPair['status'][], limit = 500): Promise<MatchedPair[]> {
  await ensureMatchedPairsTable();
  const c = getClient();
  let sql = 'SELECT * FROM matched_pairs';
  const args: string[] = [];
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    sql += ` WHERE status IN (${statuses.map(() => '?').join(',')})`;
    args.push(...statuses);
  }
  sql += ' ORDER BY matched_at DESC LIMIT ?';
  args.push(String(Math.min(Math.max(limit, 1), 5000)));
  const res = await c.execute({ sql, args });
  return (res.rows as any[]).map(rowToMatchedPair);
}

export async function getMatchedPairById(id: number): Promise<MatchedPair | null> {
  await ensureMatchedPairsTable();
  const c = getClient();
  const res = await c.execute({
    sql: 'SELECT * FROM matched_pairs WHERE id = ? LIMIT 1',
    args: [id],
  });
  const rows = res.rows as any[];
  return rows.length > 0 ? rowToMatchedPair(rows[0]) : null;
}

export async function updateMatchedPairStatus(id: number, status: MatchedPair['status'], verifiedAt?: string): Promise<boolean> {
  await ensureMatchedPairsTable();
  const c = getClient();
  const res = await c.execute({
    sql: 'UPDATE matched_pairs SET status = ?, verified_at = COALESCE(?, verified_at) WHERE id = ?',
    args: [status, verifiedAt ?? null, id],
  });
  return Number((res as any).rowsAffected ?? 0) > 0;
}

export async function approveMatchedPair(id: number): Promise<{ approved: boolean; market?: SavedMarket; error?: string }> {
  const pair = await getMatchedPairById(id);
  if (!pair) return { approved: false, error: 'Matched pair not found' };
  if (!pair.kalshiUrl || !pair.polymarketUrl) {
    return { approved: false, error: 'Pair is missing platform URLs' };
  }
  const title = pair.kalshiTitle || pair.polymarketTitle || 'Matched cross-platform pair';
  try {
    const existing = await findSavedMarketByUrls(pair.kalshiUrl, pair.polymarketUrl);
    if (existing) {
      await updateMatchedPairStatus(id, 'approved');
      return { approved: true, market: existing };
    }
    const market = await addSavedMarket({
      kalshiUrl: pair.kalshiUrl,
      polymarketUrl: pair.polymarketUrl,
      eventTitle: title,
      category: undefined,
      expiryDate: null,
    });
    await updateMatchedPairStatus(id, 'approved');
    return { approved: true, market };
  } catch (e: any) {
    return { approved: false, error: e.message };
  }
}

export async function rejectMatchedPair(id: number): Promise<boolean> {
  return updateMatchedPairStatus(id, 'rejected');
}

// ── FEAT-046: Market Catalog fetch job metadata ───────────────────

export interface MarketCatalogMetaRow {
  id: number;
  platform: 'kalshi' | 'polymarket';
  category: string;
  lastFullFetchAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: 'running' | 'idle' | 'failed' | 'aborted';
  lastSuccessfulOffset: string | null;
  marketsFetched: number;
  rateLimitHits: number;
  errorMessage: string | null;
}

function rowToMarketCatalogMeta(r: any): MarketCatalogMetaRow {
  return {
    id: Number(r.id),
    platform: String(r.platform) as 'kalshi' | 'polymarket',
    category: String(r.category ?? ''),
    lastFullFetchAt: r.last_full_fetch_at ? String(r.last_full_fetch_at) : null,
    lastRunAt: r.last_run_at ? String(r.last_run_at) : null,
    lastRunStatus: String(r.last_run_status ?? 'idle') as MarketCatalogMetaRow['lastRunStatus'],
    lastSuccessfulOffset: r.last_successful_offset ? String(r.last_successful_offset) : null,
    marketsFetched: Number(r.markets_fetched ?? 0),
    rateLimitHits: Number(r.rate_limit_hits ?? 0),
    errorMessage: r.error_message ? String(r.error_message) : null,
  };
}

async function ensureMarketCatalogMetaTable(): Promise<void> {
  await ensureDb();
  const c = getClient();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS market_catalog_meta (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      platform            TEXT    NOT NULL,
      category            TEXT    NOT NULL DEFAULT '',
      last_full_fetch_at  TEXT,
      last_run_at         TEXT,
      last_run_status     TEXT,
      last_successful_offset TEXT,
      markets_fetched     INTEGER NOT NULL DEFAULT 0,
      rate_limit_hits     INTEGER NOT NULL DEFAULT 0,
      error_message       TEXT,
      UNIQUE(platform, category)
    )
  `);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_market_catalog_meta_run ON market_catalog_meta(platform, category, last_run_at DESC)`);
}

/** Get one category meta row (or default shell) for a platform/category. */
export async function getMarketCatalogMeta(platform: 'kalshi' | 'polymarket', category: string): Promise<MarketCatalogMetaRow> {
  await ensureMarketCatalogMetaTable();
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT * FROM market_catalog_meta WHERE platform = ? AND category = ?`,
    args: [platform, category],
  });
  const rows = res.rows as any[];
  if (rows.length > 0) return rowToMarketCatalogMeta(rows[0]);
  return {
    id: 0,
    platform,
    category,
    lastFullFetchAt: null,
    lastRunAt: null,
    lastRunStatus: 'idle',
    lastSuccessfulOffset: null,
    marketsFetched: 0,
    rateLimitHits: 0,
    errorMessage: null,
  };
}

/** Upsert category-level catalog job metadata. */
export async function setMarketCatalogMeta(
  platform: 'kalshi' | 'polymarket',
  category: string,
  patch: Partial<Omit<MarketCatalogMetaRow, 'id' | 'platform' | 'category'>>,
): Promise<void> {
  await ensureMarketCatalogMetaTable();
  const c = getClient();
  await c.execute({
    sql: `INSERT INTO market_catalog_meta
            (platform, category, last_full_fetch_at, last_run_at, last_run_status,
             last_successful_offset, markets_fetched, rate_limit_hits, error_message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(platform, category) DO UPDATE SET
            last_full_fetch_at = COALESCE(excluded.last_full_fetch_at, last_full_fetch_at),
            last_run_at = COALESCE(excluded.last_run_at, last_run_at),
            last_run_status = COALESCE(excluded.last_run_status, last_run_status),
            last_successful_offset = COALESCE(excluded.last_successful_offset, last_successful_offset),
            markets_fetched = COALESCE(excluded.markets_fetched, markets_fetched),
            rate_limit_hits = COALESCE(excluded.rate_limit_hits, rate_limit_hits),
            error_message = COALESCE(excluded.error_message, error_message)`,
    args: [
      platform,
      category,
      patch.lastFullFetchAt ?? null,
      patch.lastRunAt ?? null,
      patch.lastRunStatus ?? null,
      patch.lastSuccessfulOffset ?? null,
      patch.marketsFetched ?? null,
      patch.rateLimitHits ?? null,
      patch.errorMessage ?? null,
    ],
  });
}

/** Get status overview for all catalog fetch categories. */
export async function getMarketCatalogMetaOverview(): Promise<{
  categories: MarketCatalogMetaRow[];
  totalMarkets: number;
  staleMarkets: number;
}> {
  await ensureMarketCatalogMetaTable();
  const c = getClient();
  const [catRes, countRes, staleRes] = await Promise.all([
    c.execute(`SELECT * FROM market_catalog_meta ORDER BY platform, category`),
    c.execute(`SELECT COUNT(*) AS cnt FROM market_catalog`),
    c.execute(`SELECT COUNT(*) AS cnt FROM market_catalog WHERE stale = 1`),
  ]);
  return {
    categories: (catRes.rows as any[]).map(rowToMarketCatalogMeta),
    totalMarkets: Number((countRes.rows as any[])[0]?.cnt ?? 0),
    staleMarkets: Number((staleRes.rows as any[])[0]?.cnt ?? 0),
  };
}
