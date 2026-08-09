/**
 * Arb lifecycle tracking — records every arbitrage opportunity as an EPISODE:
 * when it appeared, how it evolved (peak/last ROI, sizes), and when it closed.
 *
 * Why: EdgeFinder detects arbs but never records what happened to them. This
 * builds the dataset that answers:
 *   • which categories/markets produce DURABLE arbs vs 5-second phantoms
 *   • realistic capture rates (how long do you have to act?)
 *   • where the poller should spend its scan budget
 *
 * Model: an episode is keyed by (market_id, outcome). A scan that finds a
 * positive arb for that outcome opens (or extends) an episode. A successful
 * scan of the SAME market where that outcome no longer has a positive arb
 * closes the episode. Failed scans do NOT close episodes (absence of data
 * is not evidence of closure).
 */
import path from 'path';
import { createClient } from '@libsql/client';
import { buildArbTimingHeatmap, type TimingZone } from './arb-timing';
import { resolveMarketDomain, type Domain } from './market-classification';

const SQLITE_PATH = path.join(process.cwd(), 'data', 'edgefinder.db');
let _client: ReturnType<typeof createClient> | null = null;
function getClient() {
  if (!_client) {
    _client = createClient({ url: `file:${SQLITE_PATH}` });
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

let _inited = false;

/** Lifecycle analytics must never persist provider tags, outcome labels or
 * person/team names as categories. Prefer the saved market's canonical domain,
 * then a valid incoming domain, and finally classify the market title. */
export function resolveLifecycleCategory(
  marketTitle: string | undefined,
  incomingCategory?: unknown,
  savedCategory?: unknown,
): Domain {
  return resolveMarketDomain(marketTitle ?? '', savedCategory, incomingCategory);
}

async function canonicalizeEpisodeCategories(c: ReturnType<typeof createClient>): Promise<void> {
  const rows = await c.execute(`
    SELECT DISTINCT
      e.market_id,
      e.market_title,
      e.category AS episode_category,
      s.event_title AS saved_title,
      s.category AS saved_category
    FROM arb_episodes e
    LEFT JOIN saved_markets s ON s.id = e.market_id
  `);

  for (const row of rows.rows as any[]) {
    const title = String(row.saved_title || row.market_title || '');
    const category = resolveLifecycleCategory(title, row.episode_category, row.saved_category);
    await c.execute({
      sql: `UPDATE arb_episodes SET category = ?
            WHERE market_id = ? AND (category IS NULL OR category != ?)`,
      args: [category, String(row.market_id), category],
    });
  }
}

async function ensureDb(): Promise<void> {
  if (_inited) return;
  const c = getClient();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS arb_episodes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id       TEXT NOT NULL,
      market_title    TEXT,
      category        TEXT,
      outcome         TEXT NOT NULL,
      strategy        TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'open',   -- open | closed
      first_seen_at   TEXT NOT NULL,
      last_seen_at    TEXT NOT NULL,
      closed_at       TEXT,
      duration_sec    REAL,                            -- set on close
      scan_count      INTEGER NOT NULL DEFAULT 1,      -- scans that saw it
      first_roi_pct   REAL NOT NULL DEFAULT 0,
      last_roi_pct    REAL NOT NULL DEFAULT 0,
      peak_roi_pct    REAL NOT NULL DEFAULT 0,
      first_profit    REAL NOT NULL DEFAULT 0,
      peak_profit     REAL NOT NULL DEFAULT 0,
      first_stake     REAL NOT NULL DEFAULT 0,
      peak_stake      REAL NOT NULL DEFAULT 0
    )
  `);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_arb_episodes_market ON arb_episodes(market_id, outcome, status)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_arb_episodes_status ON arb_episodes(status, first_seen_at DESC)`);

  // UI-09: per-scan ROI data points for the decay curve. Each row = one scan
  // that saw a positive arb for this episode. This is the time series the
  // decay curve visualizes (distinct from the aggregate fields on arb_episodes).
  await c.execute(`
    CREATE TABLE IF NOT EXISTS arb_episode_points (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id      INTEGER NOT NULL REFERENCES arb_episodes(id),
      market_id       TEXT NOT NULL,
      outcome         TEXT NOT NULL,
      seen_at         TEXT NOT NULL,
      roi_pct         REAL NOT NULL,
      expected_profit REAL NOT NULL DEFAULT 0,
      total_stake     REAL NOT NULL DEFAULT 0
    )
  `);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_arb_episode_points_ep ON arb_episode_points(episode_id, seen_at)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_arb_episode_points_market ON arb_episode_points(market_id, outcome, seen_at)`);

  // BUG-113 follow-up: old rows predate canonical category validation. Repair
  // them from saved markets (or title classification) before analytics read.
  await canonicalizeEpisodeCategories(c);

  _inited = true;
}

export interface ArbObservation {
  outcome: string;
  strategy: string;
  roiPct: number;
  expectedProfit: number;
  totalStake: number;
}

/**
 * Record the arb observations from one successful scan of a market.
 * Opens new episodes, extends live ones, closes episodes whose outcome
 * no longer shows a positive arb.
 */
export async function recordArbObservations(
  marketId: string,
  marketTitle: string | undefined,
  category: string | undefined,
  arbs: ArbObservation[],
): Promise<{ opened: number; extended: number; closed: number }> {
  await ensureDb();
  const c = getClient();
  const now = new Date().toISOString();
  // The scan payload can still carry provider groupItemTitle/outcome labels.
  // Resolve against the persisted saved-market category at the final write boundary.
  const saved = await c.execute({
    sql: 'SELECT event_title, category FROM saved_markets WHERE id = ? LIMIT 1',
    args: [marketId],
  });
  const savedMarket = (saved.rows as any[])[0];
  const canonicalCategory = resolveLifecycleCategory(
    String(savedMarket?.event_title || marketTitle || ''),
    category,
    savedMarket?.category,
  );
  let opened = 0, extended = 0, closed = 0;

  // Live episodes for this market
  const live = await c.execute({
    sql: `SELECT id, outcome, last_seen_at, peak_roi_pct, peak_profit, peak_stake
          FROM arb_episodes WHERE market_id = ? AND status = 'open'`,
    args: [marketId],
  });
  const liveByOutcome = new Map<string, any>();
  for (const r of live.rows as any[]) liveByOutcome.set(String(r.outcome), r);

  const seenOutcomes = new Set<string>();
  for (const arb of arbs) {
    if (!(arb.roiPct > 0)) continue; // only positive arbs form episodes
    seenOutcomes.add(arb.outcome);
    const existing = liveByOutcome.get(arb.outcome);
    if (existing) {
      await c.execute({
        sql: `UPDATE arb_episodes SET
                last_seen_at = ?, scan_count = scan_count + 1,
                last_roi_pct = ?, strategy = ?, category = ?,
                peak_roi_pct = MAX(peak_roi_pct, ?),
                peak_profit  = MAX(peak_profit, ?),
                peak_stake   = MAX(peak_stake, ?)
              WHERE id = ?`,
        args: [now, arb.roiPct, arb.strategy, canonicalCategory, arb.roiPct, arb.expectedProfit, arb.totalStake, existing.id],
      });
      // UI-09: record per-scan ROI data point for the decay curve
      await c.execute({
        sql: `INSERT INTO arb_episode_points (episode_id, market_id, outcome, seen_at, roi_pct, expected_profit, total_stake)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [existing.id, marketId, arb.outcome, now, arb.roiPct, arb.expectedProfit, arb.totalStake],
      });
      extended++;
    } else {
      const ins = await c.execute({
        sql: `INSERT INTO arb_episodes
                (market_id, market_title, category, outcome, strategy, status,
                 first_seen_at, last_seen_at, scan_count,
                 first_roi_pct, last_roi_pct, peak_roi_pct,
                 first_profit, peak_profit, first_stake, peak_stake)
              VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        args: [marketId, marketTitle ?? null, canonicalCategory, arb.outcome, arb.strategy,
               now, now, arb.roiPct, arb.roiPct, arb.roiPct,
               arb.expectedProfit, arb.expectedProfit, arb.totalStake, arb.totalStake],
      });
      // UI-09: first data point for the new episode
      const episodeId = Number((ins as any).lastInsertRowid ?? 0);
      if (episodeId) {
        await c.execute({
          sql: `INSERT INTO arb_episode_points (episode_id, market_id, outcome, seen_at, roi_pct, expected_profit, total_stake)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [episodeId, marketId, arb.outcome, now, arb.roiPct, arb.expectedProfit, arb.totalStake],
        });
      }
      opened++;
    }
  }

  // Close episodes whose outcome no longer carries a positive arb.
  // duration = last_seen -> we credit the arb only for time we OBSERVED it
  // (conservative; real duration is somewhere between last_seen and now).
  for (const [outcome, row] of liveByOutcome) {
    if (seenOutcomes.has(outcome)) continue;
    const durationSec = Math.max(0, (new Date(row.last_seen_at).getTime() - new Date(await firstSeen(c, row.id)).getTime()) / 1000);
    await c.execute({
      sql: `UPDATE arb_episodes SET status = 'closed', closed_at = ?, duration_sec = ? WHERE id = ?`,
      args: [now, durationSec, row.id],
    });
    closed++;
  }

  return { opened, extended, closed };
}

async function firstSeen(c: ReturnType<typeof createClient>, id: number): Promise<string> {
  const r = await c.execute({ sql: 'SELECT first_seen_at FROM arb_episodes WHERE id = ?', args: [id] });
  return String((r.rows as any[])[0]?.first_seen_at ?? new Date().toISOString());
}

/** Aggregate lifecycle stats, overall and per category. */
export async function getLifecycleStats(days: number = 30): Promise<{
  totals: any;
  byCategory: any[];
  topDurable: any[];
  recentEpisodes: any[];
}> {
  await ensureDb();
  const c = getClient();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const totals = await c.execute({
    sql: `SELECT
            COUNT(*) AS episodes,
            SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open_now,
            AVG(CASE WHEN status='closed' THEN duration_sec END) AS avg_duration_sec,
            AVG(peak_roi_pct) AS avg_peak_roi,
            MAX(peak_roi_pct) AS max_peak_roi,
            SUM(CASE WHEN status='closed' AND duration_sec >= 300 THEN 1 ELSE 0 END) AS durable_5min,
            SUM(CASE WHEN status='closed' AND duration_sec < 60 THEN 1 ELSE 0 END) AS phantom_1min
          FROM arb_episodes WHERE first_seen_at >= ?`,
    args: [cutoff],
  });

  const byCategory = await c.execute({
    sql: `SELECT
            COALESCE(category, 'uncategorized') AS category,
            COUNT(*) AS episodes,
            AVG(CASE WHEN status='closed' THEN duration_sec END) AS avg_duration_sec,
            AVG(peak_roi_pct) AS avg_peak_roi,
            AVG(peak_stake) AS avg_peak_stake,
            SUM(CASE WHEN status='closed' AND duration_sec >= 300 THEN 1 ELSE 0 END) AS durable_5min
          FROM arb_episodes WHERE first_seen_at >= ?
          GROUP BY COALESCE(category, 'uncategorized')
          ORDER BY episodes DESC`,
    args: [cutoff],
  });

  const topDurable = await c.execute({
    sql: `SELECT market_id, market_title, category, outcome, strategy,
                 duration_sec, peak_roi_pct, peak_profit, peak_stake, scan_count,
                 first_seen_at, closed_at
          FROM arb_episodes
          WHERE status = 'closed' AND first_seen_at >= ?
          ORDER BY duration_sec DESC LIMIT 15`,
    args: [cutoff],
  });

  const recentEpisodes = await c.execute({
    sql: `SELECT market_id, market_title, category, outcome, strategy, status,
                 first_seen_at, last_seen_at, closed_at, duration_sec,
                 first_roi_pct, last_roi_pct, peak_roi_pct, peak_profit, peak_stake, scan_count
          FROM arb_episodes
          WHERE first_seen_at >= ?
          ORDER BY first_seen_at DESC LIMIT 50`,
    args: [cutoff],
  });

  return {
    totals: (totals.rows as any[])[0] ?? {},
    byCategory: byCategory.rows as any[],
    topDurable: topDurable.rows as any[],
    recentEpisodes: recentEpisodes.rows as any[],
  };
}

/** UI-026: trustworthy opportunity episodes grouped by weekday and hour. */
export async function getArbTimingHeatmap(
  days: number = 30,
  category?: string,
  timeZone: TimingZone = 'America/New_York',
) {
  await ensureDb();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const result = await getClient().execute({
    sql: `SELECT first_seen_at, category, status, duration_sec, scan_count, peak_roi_pct
          FROM arb_episodes
          WHERE first_seen_at >= ? AND peak_roi_pct > 0`,
    args: [cutoff],
  });
  return buildArbTimingHeatmap(result.rows as any[], { category, timeZone });
}

/** HOOKUP-02 (FEAT-004): average closed-episode lifespan for a market, in
 *  MINUTES, over the trailing `days` window. Cached 5 min per market — this
 *  feeds the persistence score's history factor on every watcher tick. */
const _lifespanCache = new Map<string, { at: number; val: number | undefined }>();
export async function getAvgEpisodeLifespanMin(
  marketId: string,
  days: number = 30,
): Promise<number | undefined> {
  const cached = _lifespanCache.get(marketId);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.val;
  await ensureDb();
  const c = getClient();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  let val: number | undefined;
  try {
    const res = await c.execute({
      sql: `SELECT AVG(duration_sec) AS avg_sec FROM arb_episodes
            WHERE market_id = ? AND status = 'closed' AND first_seen_at >= ?`,
      args: [marketId, cutoff],
    });
    const avgSec = (res.rows as any[])[0]?.avg_sec;
    val = avgSec != null ? Number(avgSec) / 60 : undefined;
  } catch {
    val = undefined;
  }
  _lifespanCache.set(marketId, { at: Date.now(), val });
  return val;
}

/** Prune closed episodes older than `days`. */
export async function pruneOldEpisodes(days: number = 90): Promise<number> {
  await ensureDb();
  const c = getClient();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const r = await c.execute({
    sql: `DELETE FROM arb_episodes WHERE status = 'closed' AND closed_at < ?`,
    args: [cutoff],
  });
  return Number((r as any).rowsAffected ?? 0);
}

/**
 * AUTO-003: realized arb yield per category over the last `days` days.
 * Returns a map of lowercased category → episode count. Categories are
 * lowercased because arb_episodes stores display categories ("Politics")
 * while discovery uses slugs ("politics").
 */
export async function getCategoryEpisodeCounts(days: number = 14): Promise<Map<string, number>> {
  await ensureDb();
  const c = getClient();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const r = await c.execute({
    sql: `SELECT LOWER(COALESCE(category, '')) AS cat, COUNT(*) AS episodes
          FROM arb_episodes WHERE first_seen_at >= ?
          GROUP BY LOWER(COALESCE(category, ''))`,
    args: [cutoff],
  });
  const m = new Map<string, number>();
  for (const row of r.rows as any[]) {
    const cat = String(row.cat || '').trim();
    if (cat) m.set(cat, Number(row.episodes ?? 0));
  }
  return m;
}

/**
 * How long the currently-OPEN episode for (market, outcome) has persisted,
 * in seconds. Returns 0 when there is no open episode (i.e. the arb is
 * brand new this scan — recordArbObservations runs before alerts fire,
 * so a first-scan arb has an episode with first_seen == last_seen ≈ now).
 * Used by alert quality filters: don't ping on arbs younger than N sec.
 */
export async function getOpenEpisodeAgeSec(marketId: string, outcome: string): Promise<number> {
  await ensureDb();
  const c = getClient();
  const r = await c.execute({
    sql: `SELECT first_seen_at FROM arb_episodes WHERE market_id = ? AND outcome = ? AND status = 'open' LIMIT 1`,
    args: [marketId, outcome],
  });
  const row = (r.rows as any[])[0];
  if (!row) return 0;
  return Math.max(0, (Date.now() - new Date(String(row.first_seen_at)).getTime()) / 1000);
}

// UI-09: Active episode decay data — per-scan ROI time series for the
// currently open episode matching (marketId, outcome). Returns null when
// no open episode exists. Uses idx_arb_episode_points_market for the scan
// point lookup and idx_arb_episodes_market for the episode header.
export interface EpisodeDecayPoint {
  seenAt: string;
  roiPct: number;
  expectedProfit: number;
  totalStake: number;
}
export interface ActiveEpisodeDecay {
  episodeId: number;
  outcome: string;
  strategy: string;
  firstSeenAt: string;
  lastSeenAt: string;
  scanCount: number;
  firstRoiPct: number;
  peakRoiPct: number;
  lastRoiPct: number;
  durationSec: number;
  points: EpisodeDecayPoint[];
  /** rising | plateau | declining — computed from last 3 scan points */
  trend: 'rising' | 'plateau' | 'declining';
}

export async function getActiveEpisodeDecay(
  marketId: string,
  outcome: string,
): Promise<ActiveEpisodeDecay | null> {
  await ensureDb();
  const c = getClient();

  // Find the open episode for this (market, outcome)
  const ep = await c.execute({
    sql: `SELECT id, outcome, strategy, first_seen_at, last_seen_at, scan_count,
                 first_roi_pct, peak_roi_pct, last_roi_pct
          FROM arb_episodes
          WHERE market_id = ? AND outcome = ? AND status = 'open'
          LIMIT 1`,
    args: [marketId, outcome],
  });
  const epRow = (ep.rows as any[])[0];
  if (!epRow) return null;

  const episodeId = Number(epRow.id);
  const firstSeenAt = String(epRow.first_seen_at);
  const lastSeenAt = String(epRow.last_seen_at);
  const durationSec = Math.max(0, (Date.now() - new Date(firstSeenAt).getTime()) / 1000);

  // Fetch per-scan ROI points, ordered by time
  const pts = await c.execute({
    sql: `SELECT seen_at, roi_pct, expected_profit, total_stake
          FROM arb_episode_points
          WHERE episode_id = ?
          ORDER BY seen_at ASC`,
    args: [episodeId],
  });
  const points: EpisodeDecayPoint[] = (pts.rows as any[]).map(r => ({
    seenAt: String(r.seen_at),
    roiPct: Number(r.roi_pct),
    expectedProfit: Number(r.expected_profit),
    totalStake: Number(r.total_stake),
  }));

  // Compute trend from last 3 scan points
  let trend: 'rising' | 'plateau' | 'declining' = 'plateau';
  if (points.length >= 3) {
    const last3 = points.slice(-3);
    const slope = last3[2].roiPct - last3[0].roiPct;
    const threshold = 0.1; // 0.1% ROI difference over 3 scans = directional
    if (slope > threshold) trend = 'rising';
    else if (slope < -threshold) trend = 'declining';
  } else if (points.length === 2) {
    const slope = points[1].roiPct - points[0].roiPct;
    if (slope > 0.1) trend = 'rising';
    else if (slope < -0.1) trend = 'declining';
  }

  return {
    episodeId,
    outcome: String(epRow.outcome),
    strategy: String(epRow.strategy ?? ''),
    firstSeenAt,
    lastSeenAt,
    scanCount: Number(epRow.scan_count),
    firstRoiPct: Number(epRow.first_roi_pct),
    peakRoiPct: Number(epRow.peak_roi_pct),
    lastRoiPct: Number(epRow.last_roi_pct),
    durationSec,
    points,
    trend,
  };
}

/** UI-09: All active episodes for a market (all outcomes), with decay data. */
export async function getActiveEpisodesForMarket(
  marketId: string,
): Promise<ActiveEpisodeDecay[]> {
  await ensureDb();
  const c = getClient();

  const eps = await c.execute({
    sql: `SELECT id, outcome FROM arb_episodes WHERE market_id = ? AND status = 'open'`,
    args: [marketId],
  });
  const results: ActiveEpisodeDecay[] = [];
  for (const row of eps.rows as any[]) {
    const decay = await getActiveEpisodeDecay(marketId, String(row.outcome));
    if (decay) results.push(decay);
  }
  return results;
}

/** Closed opportunities observed for under one minute, for the phantom review view. */
export async function getPhantomEpisodes(days = 30, category?: string): Promise<any[]> {
  await ensureDb();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const filters = ["status = 'closed'", 'duration_sec < 60', 'first_seen_at >= ?'];
  const args: (string | number)[] = [cutoff];
  if (category && category !== 'all') {
    filters.push("COALESCE(category, 'uncategorized') = ?");
    args.push(category);
  }
  const rows = await getClient().execute({
    sql: `SELECT id, market_id, market_title, COALESCE(category, 'uncategorized') AS category, outcome, strategy, first_seen_at, last_seen_at, closed_at, duration_sec, scan_count, first_roi_pct, last_roi_pct, peak_roi_pct, first_profit, peak_profit, first_stake, peak_stake FROM arb_episodes WHERE ${filters.join(' AND ')} ORDER BY first_seen_at DESC LIMIT 500`,
    args,
  });
  return rows.rows as any[];
}
