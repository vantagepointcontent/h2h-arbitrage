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
      polymarket_url  TEXT    -- source Polymarket URL for re-scanning
    )
  `);
  // Migration: add columns if missing (existing DBs)
  for (const ddl of [
    `ALTER TABLE scan_results ADD COLUMN market_title TEXT`,
    `ALTER TABLE scan_results ADD COLUMN kalshi_url TEXT`,
    `ALTER TABLE scan_results ADD COLUMN polymarket_url TEXT`,
  ]) {
    try { await c.execute(ddl); } catch { /* column already exists */ }
  }
  // Index for fast per-market lookups
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_scan_results_market_id ON scan_results(market_id)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_scan_results_scanned_at ON scan_results(scanned_at DESC)`);
  // PERF-P3: partial index for positiveArbOnly logs filter + dashboard top-arbs
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_scan_results_arbs ON scan_results(scanned_at DESC) WHERE positive_arb_count > 0`);

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
    `ALTER TABLE saved_markets ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE saved_markets ADD COLUMN archived_at TEXT`,
    `ALTER TABLE saved_markets ADD COLUMN archive_reason TEXT`,
    `ALTER TABLE saved_markets ADD COLUMN last_matched_at TEXT`,
    // WS-107: real-time result written by the ws-watcher for HOT pairs
    `ALTER TABLE saved_markets ADD COLUMN live_result TEXT`,
  ]) {
    try { await c.execute(ddl); } catch { /* column already exists */ }
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
    kalshiUrl?: string;
    polymarketUrl?: string;
  },
): Promise<{ id: number }> {
  await ensureDb();
  const c = getClient();
  const row = await c.execute({
    sql: `INSERT INTO scan_results
      (market_id, best_roi_pct, best_profit, strategy,
       outcome_count, matched_count, kalshi_count, pm_count,
       positive_arb_count, total_stake, scanned_at, raw_result, market_title,
       kalshi_url, polymarket_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      result.kalshiUrl ?? null,
      result.polymarketUrl ?? null,
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
export async function queryScanHistory(opts: {
  marketId?: string;
  minRoi?: number;
  positiveArbOnly?: boolean;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}): Promise<{ rows: any[]; total: number }> {
  await ensureDb();
  const c = getClient();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);

  let where = ' WHERE 1=1';
  const args: (string | number)[] = [];
  if (opts.marketId) { where += ' AND market_id = ?'; args.push(opts.marketId); }
  if (opts.minRoi !== undefined && !isNaN(opts.minRoi)) { where += ' AND best_roi_pct >= ?'; args.push(opts.minRoi); }
  if (opts.positiveArbOnly) { where += ' AND positive_arb_count > 0'; }
  if (opts.fromDate) { where += ' AND scanned_at >= ?'; args.push(new Date(opts.fromDate).toISOString()); }
  if (opts.toDate) { where += ' AND scanned_at <= ?'; args.push(new Date(opts.toDate).toISOString()); }

  const countRes = await c.execute({ sql: `SELECT COUNT(*) AS cnt FROM scan_results${where}`, args });
  const total = Number((countRes.rows as any[])[0]?.cnt ?? 0);

  const rows = await c.execute({
    sql: `SELECT id, market_id, market_title, best_roi_pct, best_profit, strategy,
                 outcome_count, matched_count, kalshi_count, pm_count,
                 positive_arb_count, total_stake, scanned_at, raw_result
          FROM scan_results${where}
          ORDER BY scanned_at DESC LIMIT ?`,
    args: [...args, limit],
  });
  return { rows: Array.isArray(rows.rows) ? (rows.rows as any[]) : [], total };
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
  topActiveArbs: any[];
  recurringArbs: number;
  vanishedArbs: number;
}> {
  await ensureDb();
  const c = getClient();
  const w = since ? 'WHERE scanned_at >= ?' : 'WHERE 1=1';
  const args: (string | number)[] = since ? [since] : [];
  const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 3600000).toISOString();

  const [kpiRes, perDayRes, bucketRes, hourRes, profitRes, topRes, recurRes, vanishedRes] = await Promise.all([
    c.execute({
      sql: `SELECT
              COUNT(*) AS total_scans,
              COUNT(DISTINCT market_id) AS markets_tracked,
              SUM(CASE WHEN best_roi_pct <= ? THEN positive_arb_count ELSE 0 END) AS total_arbs,
              SUM(CASE WHEN best_roi_pct <= ? AND positive_arb_count > 0 AND scanned_at >= ? THEN 1 ELSE 0 END) AS active_arbs,
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
      // Best-ROI scan per market among non-phantom positive arbs, top 10.
      sql: `SELECT id, market_id, market_title, best_roi_pct, best_profit,
                   strategy, positive_arb_count, scanned_at
            FROM (
              SELECT *, ROW_NUMBER() OVER (
                PARTITION BY market_id ORDER BY best_roi_pct DESC
              ) AS rn
              FROM scan_results ${w}
                AND positive_arb_count > 0 AND best_roi_pct <= ?
            ) WHERE rn = 1
            ORDER BY best_roi_pct DESC LIMIT 10`,
      args: [...args, suspiciousRoi],
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

  // Fixed 30-day window for the scans-per-day chart (fills gaps with 0)
  const scansPerDay: { date: string; count: number }[] = [];
  const todayMid = new Date();
  const today = new Date(todayMid.getFullYear(), todayMid.getMonth(), todayMid.getDate());
  for (let i = 29; i >= 0; i--) {
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
    topActiveArbs: (topRes.rows as any[]).map((r) => ({
      id: r.id,
      market_id: r.market_id,
      market_title: r.market_title || null,
      best_roi_pct: r.best_roi_pct,
      best_profit: r.best_profit,
      strategy: r.strategy,
      positive_arb_count: r.positive_arb_count,
      scanned_at: r.scanned_at,
    })),
    recurringArbs: Number((recurRes.rows as any[])[0]?.cnt ?? 0),
    vanishedArbs: Number((vanishedRes.rows as any[])[0]?.cnt ?? 0),
  };
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
  pmClosed?: boolean;       // UI-013: PM reports market closed (endDate may still be future)
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

function rowToMarket(r: any): SavedMarket {
  let lastScanResult: LastScanResult | null = null;
  try { lastScanResult = r.last_scan_result ? JSON.parse(String(r.last_scan_result)) : null; } catch {}
  let liveResult: LastScanResult | null = null;
  try { liveResult = r.live_result ? JSON.parse(String(r.live_result)) : null; } catch {}
  // WS-107: a live result is only trustworthy while the watcher is actively
  // recomputing it. If it's older than the TTL (watcher down, pair left HOT
  // tier), drop it so the UI falls back to the poller's lastScanResult.
  if (liveResult?.scannedAt) {
    const age = Date.now() - new Date(liveResult.scannedAt).getTime();
    if (!(age >= 0 && age <= LIVE_RESULT_TTL_MS)) liveResult = null;
  } else {
    liveResult = null;
  }
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
    liveResult,
    archived: Boolean(Number(r.archived ?? 0)),
    archivedAt: r.archived_at != null ? String(r.archived_at) : null,
    archiveReason: r.archive_reason != null ? String(r.archive_reason) : null,
    lastMatchedAt: r.last_matched_at != null ? String(r.last_matched_at) : null,
  };
}

async function upsertMarketRow(m: SavedMarket): Promise<void> {
  const c = getClient();
  await c.execute({
    sql: `INSERT INTO saved_markets
            (id, kalshi_url, polymarket_url, event_title, category, created_at, expiry_date, favorite, last_scan_result,
             archived, archived_at, archive_reason, last_matched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kalshi_url = excluded.kalshi_url,
            polymarket_url = excluded.polymarket_url,
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
      m.id, m.kalshiUrl, m.polymarketUrl, m.eventTitle, m.category ?? null,
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

export async function updateSavedMarketScanResult(id: string, result: LastScanResult, expiryDate?: string | null): Promise<void> {
  // Targeted UPDATE — no read-modify-write of the whole list. This was the
  // main race: concurrent scans clobbering each other's lastScanResult.
  await ensureMarketsMigrated();
  const c = getClient();
  // AUTO-002: track last time this market had matched outcomes (dead-market detection)
  const matchedNow = (result?.matchedCount ?? 0) > 0 ? new Date().toISOString() : null;
  if (expiryDate !== undefined) {
    await c.execute({
      sql: 'UPDATE saved_markets SET last_scan_result = ?, expiry_date = ?, last_matched_at = COALESCE(?, last_matched_at) WHERE id = ?',
      args: [JSON.stringify(result), expiryDate ?? null, matchedNow, id],
    });
  invalidateMarketsCache();
  } else {
    await c.execute({
      sql: 'UPDATE saved_markets SET last_scan_result = ?, last_matched_at = COALESCE(?, last_matched_at) WHERE id = ?',
      args: [JSON.stringify(result), matchedNow, id],
    });
  invalidateMarketsCache();
  }
  mirrorMarketsToJsonThrottled();
}

// WS-107: watcher-written real-time result ─────────────────────────
/** How long a liveResult stays valid without a fresh watcher write. */
export const LIVE_RESULT_TTL_MS = Number(process.env.H2H_LIVE_RESULT_TTL_MS || 10 * 60_000);

/** WS-107: persist the watcher's real-time computation for a HOT market.
 *  Targeted UPDATE of live_result only — never touches last_scan_result, so
 *  the REST poller and the watcher can't clobber each other.
 *  Skips the JSON mirror by design: live writes are frequent and the mirror
 *  (poller input) should stay driven by poller-cadence scans. */
export async function updateSavedMarketLiveResult(id: string, result: LastScanResult): Promise<void> {
  await ensureMarketsMigrated();
  const c = getClient();
  const matchedNow = (result?.matchedCount ?? 0) > 0 ? new Date().toISOString() : null;
  await c.execute({
    sql: 'UPDATE saved_markets SET live_result = ?, last_matched_at = COALESCE(?, last_matched_at) WHERE id = ?',
    args: [JSON.stringify(result), matchedNow, id],
  });
  invalidateMarketsCache();
}

/** WS-107: clear a market's live result (pair left HOT tier / watcher shutdown). */
export async function clearSavedMarketLiveResult(id: string): Promise<void> {
  await ensureMarketsMigrated();
  const c = getClient();
  await c.execute({ sql: 'UPDATE saved_markets SET live_result = NULL WHERE id = ?', args: [id] });
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
  await c.execute({
    sql: `INSERT INTO scan_history (scan_timestamp, market_id, total_profit, best_roi_pct, positive_arb_count, matched_count)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [entry.scanTimestamp, entry.marketId, entry.totalProfit ?? 0, entry.bestRoiPct ?? 0, entry.positiveArbCount ?? 0, entry.matchedCount ?? 0],
  });
  // Bounded: keep the most recent 5000 rows (was 500 in JSON — cheap in SQLite)
  await c.execute(`DELETE FROM scan_history WHERE id NOT IN (SELECT id FROM scan_history ORDER BY scan_timestamp DESC LIMIT 5000)`);
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
      estimated_profit REAL    NOT NULL DEFAULT 0
    )`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_executions_ts ON executions(timestamp DESC)`);
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
}

export async function persistExecution(e: ExecutionRecord): Promise<void> {
  await ensureExecutionsTable();
  const c = getClient();
  await c.execute({
    sql: `INSERT INTO executions (timestamp, arb_id, market_title, dry_run, success, strategy, kalshi_order, polymarket_order, result, estimated_profit)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      e.timestamp, e.arbId, e.marketTitle, e.dryRun ? 1 : 0, e.success ? 1 : 0,
      e.strategy ?? null,
      e.kalshiOrder != null ? JSON.stringify(e.kalshiOrder) : null,
      e.polymarketOrder != null ? JSON.stringify(e.polymarketOrder) : null,
      e.result != null ? JSON.stringify(e.result) : null,
      e.estimatedProfit ?? 0,
    ],
  });
}

export async function getExecutions(limit = 200): Promise<ExecutionRecord[]> {
  await ensureExecutionsTable();
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT * FROM executions ORDER BY timestamp DESC LIMIT ?`,
    args: [Math.min(1000, Math.max(1, limit))],
  });
  return (res.rows as any[]).map((r) => ({
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
  }));
}
