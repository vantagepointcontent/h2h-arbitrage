/**
 * SETTINGS-001: DB-backed application settings with hot-reload.
 *
 * Single source of truth for tunable thresholds. Resolution order:
 *   1. `settings` table in data/edgefinder.db (set via Settings UI / API)
 *   2. Environment variable fallback
 *   3. Code default
 *
 * Values are cached in-memory with a short TTL so both the Next.js app
 * and API consumers pick up changes within ~10s — no restart required.
 */
import path from 'path';
import { createClient } from '@libsql/client';

const SQLITE_PATH = path.join(process.cwd(), 'data', 'edgefinder.db');
let _client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (!_client) {
    _client = createClient({ url: `file:${SQLITE_PATH}` });
    void _client.execute('PRAGMA busy_timeout = 5000').catch(() => {});
  }
  return _client;
}

/* ─────────────────────────── Schema ─────────────────────────── */

export type SettingType = 'number' | 'boolean' | 'string';

export interface SettingDef {
  key: string;
  section: 'alerts' | 'scanner' | 'auto-discovery' | 'auto-execute' | 'lifecycle' | 'display';
  label: string;
  description: string;
  type: SettingType;
  /** Env var used as fallback when no DB value exists */
  env?: string;
  default: number | boolean | string;
  min?: number;
  max?: number;
  /** Numbers only: render as slider in the UI */
  slider?: boolean;
  /** Requires an extra confirm in the UI (dangerous toggles) */
  dangerous?: boolean;
  /** Allowed values for string settings */
  options?: string[];
}

export const SETTINGS_SCHEMA: SettingDef[] = [
  // ── Alerts ──
  { key: 'alerts.paused', section: 'alerts', label: 'Pause Telegram alerts', description: 'Master switch. When on, no alerts fire regardless of thresholds.', type: 'boolean', env: 'TELEGRAM_ALERTS_PAUSED', default: false },
  { key: 'alerts.minRoiPct', section: 'alerts', label: 'Min ROI %', description: 'Minimum net ROI (after fees) for an alert.', type: 'number', env: 'TELEGRAM_MIN_ROI_PCT', default: 1.5, min: 0, max: 50, slider: true },
  { key: 'alerts.minProfitUsd', section: 'alerts', label: 'Min profit $', description: 'Minimum net profit in USD for an alert.', type: 'number', env: 'TELEGRAM_MIN_PROFIT_USD', default: 5, min: 0, max: 1000 },
  { key: 'alerts.minStakeUsd', section: 'alerts', label: 'Min stake $', description: 'Minimum executable stake. Filters out tiny-liquidity noise.', type: 'number', env: 'TELEGRAM_MIN_STAKE_USD', default: 50, min: 0, max: 10000 },
  { key: 'alerts.cooldownMs', section: 'alerts', label: 'Cooldown (ms)', description: 'Per-market cooldown between alerts.', type: 'number', env: 'TELEGRAM_COOLDOWN_MS', default: 300000, min: 0, max: 3600000 },
  { key: 'alerts.minPersistenceSec', section: 'alerts', label: 'Min persistence (s)', description: 'Arb must survive this long before alerting. Kills phantoms.', type: 'number', env: 'TELEGRAM_MIN_PERSISTENCE_SEC', default: 60, min: 0, max: 3600, slider: true },

  // ── Scanner ──
  { key: 'scanner.pollConcurrency', section: 'scanner', label: 'Poll concurrency', description: 'Parallel market scans in the poller.', type: 'number', env: 'H2H_POLL_CONCURRENCY', default: 5, min: 1, max: 20, slider: true },
  { key: 'scanner.scanTimeoutMs', section: 'scanner', label: 'Scan timeout (ms)', description: 'Per-scan hard timeout before abort.', type: 'number', env: 'H2H_SCAN_TIMEOUT_MS', default: 60000, min: 5000, max: 300000 },
  { key: 'watcher.hotMaxKalshi', section: 'scanner', label: 'Watcher: max Kalshi tickers', description: 'WS-103: HOT-tier cap on live-streamed Kalshi tickers in the WS watcher.', type: 'number', env: 'H2H_WATCHER_MAX_KALSHI', default: 200, min: 10, max: 1000, slider: true },
  { key: 'watcher.hotMaxPmTokens', section: 'scanner', label: 'Watcher: max PM tokens', description: 'WS-103: HOT-tier cap on live-streamed Polymarket token IDs in the WS watcher.', type: 'number', env: 'H2H_WATCHER_MAX_PM_TOKENS', default: 400, min: 20, max: 2000, slider: true },
  { key: 'watcher.demoteAfterDays', section: 'scanner', label: 'Watcher: demote after (days)', description: 'WS-103: HOT pairs with no arb episode within this window score down toward WARM.', type: 'number', default: 14, min: 1, max: 60, slider: true },

  // ── Auto-Discovery ──
  { key: 'discovery.paused', section: 'auto-discovery', label: 'Pause auto-discovery', description: 'Stop automatic category scans for new market pairs.', type: 'boolean', default: false },
  { key: 'discovery.scanIntervalHours', section: 'auto-discovery', label: 'Scan interval (h)', description: 'Hours between auto-discovery category scans.', type: 'number', default: 3, min: 1, max: 24, slider: true },
  { key: 'discovery.autoApproveConfidence', section: 'auto-discovery', label: 'Auto-approve confidence', description: 'Pairs at or above this confidence are saved automatically (AUTO-001, when implemented).', type: 'number', default: 85, min: 50, max: 100, slider: true },
  { key: 'discovery.maxMarketsPerScan', section: 'auto-discovery', label: 'Max markets per scan', description: 'Cap on markets added by a single discovery scan.', type: 'number', default: 10, min: 1, max: 100 },
  { key: 'discovery.yieldBias', section: 'auto-discovery', label: 'Yield bias', description: 'AUTO-003: how strongly category scans favor categories with realized arb episodes (0 = pure round-robin, 100 = heavily biased). Every category still gets scanned periodically.', type: 'number', default: 50, min: 0, max: 100, slider: true },

  // ── Lifecycle (AUTO-002) ──
  { key: 'lifecycle.enabled', section: 'lifecycle', label: 'Auto-retirement', description: 'Automatically archive expired or dead markets so they stop consuming polling budget.', type: 'boolean', default: true },
  { key: 'lifecycle.expiryGraceHours', section: 'lifecycle', label: 'Expiry grace (h)', description: 'Hours after market expiry before it is archived (allows settlement-window arbs).', type: 'number', default: 24, min: 0, max: 168, slider: true },
  { key: 'lifecycle.deadMarketDays', section: 'lifecycle', label: 'Dead-market days', description: 'Archive markets with zero matched outcomes for this many consecutive days.', type: 'number', default: 7, min: 1, max: 60, slider: true },
  { key: 'lifecycle.protectFavorites', section: 'lifecycle', label: 'Protect favorites', description: 'Never auto-archive starred markets.', type: 'boolean', default: true },

  // ── Auto-Execute ──
  { key: 'execute.killSwitch', section: 'auto-execute', label: 'Execution kill switch', description: 'Master stop. When ON, /api/execute refuses ALL execution requests (even dry-run). Turn OFF only when you intend to trade.', type: 'boolean', default: true, dangerous: true },
  { key: 'execute.dryRun', section: 'auto-execute', label: 'Dry run mode', description: 'When ON, executions are simulated. Turning this OFF places REAL orders.', type: 'boolean', env: 'H2H_DRY_RUN', default: true, dangerous: true },
  { key: 'execute.maxStakePerTrade', section: 'auto-execute', label: 'Max stake per trade $', description: 'Hard cap on a single execution stake.', type: 'number', env: 'H2H_MAX_STAKE_USD', default: 100, min: 1, max: 10000 },
  { key: 'execute.maxDailyExposure', section: 'auto-execute', label: 'Max daily exposure $', description: 'Total capital deployable per day across all executions.', type: 'number', env: 'H2H_MAX_DAILY_USD', default: 500, min: 1, max: 100000 },

  // ── Display ──
  { key: 'display.defaultSort', section: 'display', label: 'Default overview sort', description: 'Initial sort order in Overview.', type: 'string', default: 'apy', options: ['apy', 'roi', 'name', 'expiry'] },
  { key: 'display.hideUnmatched', section: 'display', label: 'Hide unmatched by default', description: 'Overview starts with only matched markets visible.', type: 'boolean', default: true },
];

const SCHEMA_BY_KEY = new Map(SETTINGS_SCHEMA.map((d) => [d.key, d]));

/* ────────────────────────── Storage ─────────────────────────── */

let _initialized = false;
async function ensureTable(): Promise<void> {
  if (_initialized) return;
  await getClient().execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  _initialized = true;
}

/* ──────────────────────────── Cache ─────────────────────────── */

const CACHE_TTL_MS = Math.max(1000, Number(process.env.H2H_SETTINGS_CACHE_MS ?? 10000));
let _cache: Map<string, string> | null = null;
let _cacheAt = 0;

async function loadDbValues(): Promise<Map<string, string>> {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  await ensureTable();
  const rs = await getClient().execute('SELECT key, value FROM settings');
  const m = new Map<string, string>();
  for (const row of rs.rows) m.set(String(row.key), String(row.value));
  _cache = m;
  _cacheAt = now;
  return m;
}

/** Force next read to hit the DB (used after writes). */
export function invalidateSettingsCache(): void {
  _cache = null;
  _cacheAt = 0;
}

/* ─────────────────────────── Coercion ───────────────────────── */

function coerce(def: SettingDef, raw: string): number | boolean | string {
  if (def.type === 'boolean') return raw === 'true' || raw === '1';
  if (def.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return def.default;
    if (def.min !== undefined && n < def.min) return def.min;
    if (def.max !== undefined && n > def.max) return def.max;
    return n;
  }
  if (def.options && !def.options.includes(raw)) return def.default;
  return raw;
}

/** Validate a raw incoming value for a key. Returns error string or null. */
export function validateSetting(key: string, value: unknown): string | null {
  const def = SCHEMA_BY_KEY.get(key);
  if (!def) return `Unknown setting: ${key}`;
  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') return `${key}: expected boolean`;
    return null;
  }
  if (def.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${key}: expected finite number`;
    if (def.min !== undefined && value < def.min) return `${key}: below min ${def.min}`;
    if (def.max !== undefined && value > def.max) return `${key}: above max ${def.max}`;
    return null;
  }
  if (typeof value !== 'string') return `${key}: expected string`;
  if (def.options && !def.options.includes(value)) return `${key}: must be one of ${def.options.join(', ')}`;
  return null;
}

/* ─────────────────────────── Reads ──────────────────────────── */

/**
 * Resolve a setting: DB > env > default. Async (hits cached DB read).
 */
export async function getSetting<T = number | boolean | string>(key: string): Promise<T> {
  const def = SCHEMA_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting: ${key}`);
  try {
    const db = await loadDbValues();
    const raw = db.get(key);
    if (raw !== undefined) return coerce(def, raw) as T;
  } catch {
    /* DB unavailable — fall through to env/default */
  }
  if (def.env && process.env[def.env] !== undefined && process.env[def.env] !== '') {
    return coerce(def, String(process.env[def.env])) as T;
  }
  return def.default as T;
}

export interface ResolvedSetting extends SettingDef {
  value: number | boolean | string;
  source: 'db' | 'env' | 'default';
  updatedAt: string | null;
}

/** Resolve every setting with its source, for the Settings UI. */
export async function getAllSettings(): Promise<ResolvedSetting[]> {
  let db = new Map<string, string>();
  const updatedAt = new Map<string, string>();
  try {
    db = await loadDbValues();
    await ensureTable();
    const rs = await getClient().execute('SELECT key, updated_at FROM settings');
    for (const row of rs.rows) updatedAt.set(String(row.key), String(row.updated_at));
  } catch { /* env/default only */ }

  return SETTINGS_SCHEMA.map((def) => {
    const raw = db.get(def.key);
    if (raw !== undefined) {
      return { ...def, value: coerce(def, raw), source: 'db' as const, updatedAt: updatedAt.get(def.key) ?? null };
    }
    if (def.env && process.env[def.env] !== undefined && process.env[def.env] !== '') {
      return { ...def, value: coerce(def, String(process.env[def.env])), source: 'env' as const, updatedAt: null };
    }
    return { ...def, value: def.default, source: 'default' as const, updatedAt: null };
  });
}

/* ─────────────────────────── Writes ─────────────────────────── */

/**
 * Set one or more settings. All values are validated first; nothing is
 * written unless every value passes (all-or-nothing).
 */
export async function setSettings(values: Record<string, unknown>): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const err = validateSetting(key, value);
    if (err) errors.push(err);
  }
  if (errors.length) return { ok: false, errors };

  await ensureTable();
  const now = new Date().toISOString();
  const c = getClient();
  for (const [key, value] of Object.entries(values)) {
    await c.execute({
      sql: 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      args: [key, String(value), now],
    });
  }
  invalidateSettingsCache();
  return { ok: true, errors: [] };
}

/** Remove a DB override so the setting falls back to env/default. */
export async function resetSetting(key: string): Promise<void> {
  if (!SCHEMA_BY_KEY.has(key)) throw new Error(`Unknown setting: ${key}`);
  await ensureTable();
  await getClient().execute({ sql: 'DELETE FROM settings WHERE key = ?', args: [key] });
  invalidateSettingsCache();
}
