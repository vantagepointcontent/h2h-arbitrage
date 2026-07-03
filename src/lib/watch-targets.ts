// WS-103: watch_targets persistence + Target Resolver + Tier Manager.
// Resolves active saved markets into streamable targets (cached in SQLite so
// watcher restarts are warm) and scores them into HOT (WS-subscribed) vs WARM
// (REST poller only) tiers with promotion/demotion.

import path from 'path';
import { createClient } from '@libsql/client';
import { resolvePair, PairResolveError } from './pair-resolver';
import { getSetting } from './settings';
import logger from './logger';

const SQLITE_PATH = path.join(process.cwd(), 'data', 'edgefinder.db');
let _client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (!_client) {
    _client = createClient({ url: `file:${SQLITE_PATH}` });
    void _client.execute('PRAGMA busy_timeout = 5000').catch(() => {});
  }
  return _client;
}

let _initialized = false;
async function ensureTables(): Promise<void> {
  if (_initialized) return;
  const c = getClient();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS watch_targets (
      pair_id        TEXT NOT NULL,           -- saved_markets.id
      kalshi_ticker  TEXT NOT NULL,
      pm_yes_token   TEXT NOT NULL,
      pm_no_token    TEXT NOT NULL,
      artist         TEXT NOT NULL DEFAULT '',
      category       TEXT,
      resolved_at    TEXT NOT NULL,
      PRIMARY KEY (pair_id, kalshi_ticker)
    )
  `);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_watch_targets_pair ON watch_targets(pair_id)`);
  await c.execute(`
    CREATE TABLE IF NOT EXISTS watch_tier_state (
      pair_id      TEXT PRIMARY KEY,
      tier         TEXT NOT NULL DEFAULT 'warm',   -- 'hot' | 'warm'
      score        REAL NOT NULL DEFAULT 0,
      promoted_at  TEXT,
      promote_flag INTEGER NOT NULL DEFAULT 0,     -- set by poller on positive-gross arb
      updated_at   TEXT NOT NULL
    )
  `);
  _initialized = true;
}

export interface WatchTarget {
  pairId: string;
  kalshiTicker: string;
  pmYesToken: string;
  pmNoToken: string;
  artist: string;
  category?: string;
  resolvedAt: string;
}

export interface TierAssignment {
  hot: WatchTarget[];
  warm: WatchTarget[];
  hotPairIds: string[];
  stats: { pairs: number; hotPairs: number; kalshiTickers: number; pmTokens: number };
}

const RESOLVE_TTL_MS = 6 * 3600_000; // re-resolve pairs older than 6h
const RESOLVE_CONCURRENCY = 3;       // gentle on rate limiters

/* ─────────────────────── Target Resolver ─────────────────────── */

/**
 * Resolve active saved markets into watch_targets, incrementally.
 * Only pairs with no cached rows or rows older than TTL are re-resolved,
 * so a watcher restart is warm (seconds, not a 1500-request cold storm).
 * Returns number of pairs (re)resolved.
 */
export async function refreshWatchTargets(): Promise<{ resolved: number; failed: number; cached: number }> {
  await ensureTables();
  const c = getClient();

  const markets = await c.execute(
    `SELECT id, kalshi_url, polymarket_url, category FROM saved_markets
     WHERE (archived = 0 OR archived IS NULL)`,
  );

  const cutoff = new Date(Date.now() - RESOLVE_TTL_MS).toISOString();
  const freshRows = await c.execute(
    `SELECT DISTINCT pair_id FROM watch_targets WHERE resolved_at >= ?`,
    [cutoff],
  );
  const fresh = new Set(freshRows.rows.map((r) => String(r.pair_id)));

  const stale = markets.rows.filter((m) => !fresh.has(String(m.id)));
  let resolved = 0;
  let failed = 0;

  // Simple concurrency pool
  const queue = [...stale];
  const workers = Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const m = queue.shift();
      if (!m) return;
      const pairId = String(m.id);
      try {
        const r = await resolvePair(String(m.kalshi_url), String(m.polymarket_url), 100);
        const now = new Date().toISOString();
        await c.execute(`DELETE FROM watch_targets WHERE pair_id = ?`, [pairId]);
        for (const o of r.matchedOutcomes) {
          await c.execute(
            `INSERT OR REPLACE INTO watch_targets (pair_id, kalshi_ticker, pm_yes_token, pm_no_token, artist, category, resolved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [pairId, o.kalshiTicker, o.pmYesTokenId, o.pmNoTokenId, o.artist, r.category ?? (m.category ? String(m.category) : null), now],
          );
        }
        resolved++;
      } catch (err) {
        failed++;
        if (err instanceof PairResolveError) {
          logger.debug('[watch-targets] pair unresolvable', { pairId, code: err.code });
        } else {
          logger.warn('[watch-targets] pair resolution error', { pairId, err });
        }
      }
    }
  });
  await Promise.all(workers);

  return { resolved, failed, cached: fresh.size };
}

/* ─────────────────────── Tier Manager ────────────────────────── */

/**
 * Score all pairs and split into HOT/WARM, respecting subscription caps.
 * Scoring signals (strongest first):
 *  - promote_flag set by the REST poller (positive-gross arb seen) → immediate HOT
 *  - recency of arb_episodes for the pair's market (14d window)
 *  - favorite flag
 *  - time-to-expiry (expiring soon = hotter)
 * Demotion: pairs with no episode within demoteAfterDays and no promote flag
 * decay naturally by scoring low.
 */
export async function computeTiers(): Promise<TierAssignment> {
  await ensureTables();
  const c = getClient();

  const hotMaxKalshi = await getSetting<number>('watcher.hotMaxKalshi');
  const hotMaxPm = await getSetting<number>('watcher.hotMaxPmTokens');

  const rows = await c.execute(`
    SELECT wt.pair_id, wt.kalshi_ticker, wt.pm_yes_token, wt.pm_no_token, wt.artist, wt.category, wt.resolved_at,
           sm.favorite, sm.expiry_date,
           COALESCE(ts.promote_flag, 0) AS promote_flag,
           (SELECT MAX(ae.last_seen_at) FROM arb_episodes ae WHERE ae.market_id = wt.pair_id) AS last_episode_at,
           (SELECT COUNT(*) FROM arb_episodes ae WHERE ae.market_id = wt.pair_id
              AND ae.last_seen_at >= datetime('now', '-14 days')) AS episodes_14d
    FROM watch_targets wt
    JOIN saved_markets sm ON sm.id = wt.pair_id
    LEFT JOIN watch_tier_state ts ON ts.pair_id = wt.pair_id
    WHERE (sm.archived = 0 OR sm.archived IS NULL)
  `);

  // Group targets by pair, score per pair
  const byPair = new Map<string, { targets: WatchTarget[]; score: number; promote: boolean }>();
  const nowMs = Date.now();

  for (const r of rows.rows) {
    const pairId = String(r.pair_id);
    let entry = byPair.get(pairId);
    if (!entry) {
      let score = 0;
      const promote = Number(r.promote_flag) === 1;
      if (promote) score += 10_000;
      const episodes14d = Number(r.episodes_14d) || 0;
      score += Math.min(episodes14d, 50) * 100;
      if (r.last_episode_at) {
        const ageDays = (nowMs - new Date(String(r.last_episode_at)).getTime()) / 86_400_000;
        if (isFinite(ageDays) && ageDays >= 0) score += Math.max(0, 500 - ageDays * 35); // fades over ~14d
      }
      if (Number(r.favorite) === 1) score += 300;
      if (r.expiry_date) {
        const hrsToExpiry = (new Date(String(r.expiry_date)).getTime() - nowMs) / 3600_000;
        if (isFinite(hrsToExpiry) && hrsToExpiry > 0 && hrsToExpiry < 48) score += (48 - hrsToExpiry) * 5;
      }
      entry = { targets: [], score, promote };
      byPair.set(pairId, entry);
    }
    entry.targets.push({
      pairId,
      kalshiTicker: String(r.kalshi_ticker),
      pmYesToken: String(r.pm_yes_token),
      pmNoToken: String(r.pm_no_token),
      artist: String(r.artist),
      category: r.category ? String(r.category) : undefined,
      resolvedAt: String(r.resolved_at),
    });
  }

  // Sort pairs by score desc, fill HOT until either cap is reached
  const sorted = [...byPair.entries()].sort((a, b) => b[1].score - a[1].score);
  const hot: WatchTarget[] = [];
  const warm: WatchTarget[] = [];
  const hotPairIds: string[] = [];
  let kalshiCount = 0;
  let pmCount = 0;

  for (const [pairId, entry] of sorted) {
    const kTickers = new Set(entry.targets.map((t) => t.kalshiTicker)).size;
    const pmTokens = entry.targets.length * 2;
    const fits = kalshiCount + kTickers <= hotMaxKalshi && pmCount + pmTokens <= hotMaxPm;
    if (fits && entry.score > 0) {
      hot.push(...entry.targets);
      hotPairIds.push(pairId);
      kalshiCount += kTickers;
      pmCount += pmTokens;
    } else {
      warm.push(...entry.targets);
    }
  }

  // Persist tier state; clear promote flags for pairs now HOT (flag consumed)
  const now = new Date().toISOString();
  for (const [pairId, entry] of sorted) {
    const tier = hotPairIds.includes(pairId) ? 'hot' : 'warm';
    await c.execute(
      `INSERT INTO watch_tier_state (pair_id, tier, score, promoted_at, promote_flag, updated_at)
       VALUES (?, ?, ?, CASE WHEN ? = 'hot' THEN ? ELSE NULL END, 0, ?)
       ON CONFLICT(pair_id) DO UPDATE SET
         tier = excluded.tier,
         score = excluded.score,
         promoted_at = CASE WHEN excluded.tier = 'hot' AND watch_tier_state.tier != 'hot' THEN excluded.updated_at ELSE watch_tier_state.promoted_at END,
         promote_flag = 0,
         updated_at = excluded.updated_at`,
      [pairId, tier, entry.score, tier, now, now],
    );
  }

  return {
    hot,
    warm,
    hotPairIds,
    stats: { pairs: byPair.size, hotPairs: hotPairIds.length, kalshiTickers: kalshiCount, pmTokens: pmCount },
  };
}

/* ─────────────────── Promotion hook (poller side) ─────────────── */

/**
 * Flag a pair for immediate HOT promotion. Called by the REST poller when it
 * sees any positive-gross arb on a WARM pair. The watcher's next tier pass
 * (fast interval) picks it up.
 */
export async function flagForPromotion(pairId: string): Promise<void> {
  await ensureTables();
  const now = new Date().toISOString();
  await getClient().execute(
    `INSERT INTO watch_tier_state (pair_id, tier, score, promote_flag, updated_at)
     VALUES (?, 'warm', 0, 1, ?)
     ON CONFLICT(pair_id) DO UPDATE SET promote_flag = 1, updated_at = excluded.updated_at`,
    [pairId, now],
  );
}

/** Read current tier for a set of pairs (diagnostics / UI). */
export async function getTierState(): Promise<{ pairId: string; tier: string; score: number; promoteFlag: boolean; updatedAt: string }[]> {
  await ensureTables();
  const rs = await getClient().execute(`SELECT pair_id, tier, score, promote_flag, updated_at FROM watch_tier_state`);
  return rs.rows.map((r) => ({
    pairId: String(r.pair_id),
    tier: String(r.tier),
    score: Number(r.score),
    promoteFlag: Number(r.promote_flag) === 1,
    updatedAt: String(r.updated_at),
  }));
}
