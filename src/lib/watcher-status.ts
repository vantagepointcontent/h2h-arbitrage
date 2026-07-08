// WS-106: Pure helpers for surfacing watcher health + tick freshness in the UI.
// No I/O here — everything is unit-testable. Consumers: SettingsPanel watcher
// health card, MarketSidebar HOT badges + freshness dots.

/* ─────────────────────── Types ─────────────────────── */

export interface WatcherHealthPayload {
  status?: string;                 // 'ok' | 'stalled' | 'down' (from /api/watcher/health)
  ts?: string;
  kalshiConnected?: boolean;
  pmConnections?: string;          // e.g. "1/1"
  hotPairs?: number;
  kalshiTickers?: number;
  pmTokens?: number;
  msgCount?: number;
  lastTickAt?: string;
  healthFileAgeMs?: number | null;
  error?: string;
  tierStats?: { pairs?: number; hotPairs?: number; kalshiTickers?: number; pmTokens?: number };
  integrity?: {
    degraded?: boolean;
    degradedSince?: string | null;
    flapsInWindow?: number;
    seqGaps?: number;
    staleReseeds?: number;
    reconcilePasses?: number;
    reconcileDisagreements?: number;
    lastReconcileAt?: string | null;
  };
}

export type WatcherStatusLevel = 'ok' | 'degraded' | 'stalled' | 'down';

/* ─────────────────── Status classification ─────────────────── */

/**
 * Collapse the health payload into a single displayable status.
 * Priority: down > stalled > degraded > ok.
 * A payload reporting status 'ok' but with integrity.degraded=true is DEGRADED.
 * Disconnected WS legs (kalshi or PM) also count as degraded — data is flowing
 * from at most one platform, so arb detection is unreliable.
 */
export function classifyWatcherStatus(h: WatcherHealthPayload | null | undefined): WatcherStatusLevel {
  if (!h || !h.status) return 'down';
  if (h.status === 'down') return 'down';
  if (h.status === 'stalled') return 'stalled';
  if (h.integrity?.degraded) return 'degraded';
  if (h.kalshiConnected === false) return 'degraded';
  const pm = parseConnectionRatio(h.pmConnections);
  if (pm && pm.connected < pm.total) return 'degraded';
  return 'ok';
}

/** Parse a "connected/total" string like "1/1" → { connected, total }. Null if unparseable. */
export function parseConnectionRatio(s: string | null | undefined): { connected: number; total: number } | null {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;
  return { connected: Number(m[1]), total: Number(m[2]) };
}

/* ─────────────────── Msg rate (msgs/sec) ─────────────────── */

/**
 * Compute messages/sec from two successive health snapshots.
 * Returns null when a rate can't be derived (first sample, counter reset
 * after watcher restart, or non-positive time delta).
 */
export function computeMsgRate(
  prev: { msgCount: number; ts: string } | null,
  curr: { msgCount?: number; ts?: string } | null | undefined,
): number | null {
  if (!prev || !curr || typeof curr.msgCount !== 'number' || !curr.ts) return null;
  const dtMs = Date.parse(curr.ts) - Date.parse(prev.ts);
  if (!Number.isFinite(dtMs) || dtMs <= 0) return null;
  const dMsgs = curr.msgCount - prev.msgCount;
  if (dMsgs < 0) return null; // counter reset (watcher restarted)
  return Math.round((dMsgs / (dtMs / 1000)) * 10) / 10;
}

/* ─────────────────── Tick freshness ─────────────────── */

export type FreshnessLevel = 'live' | 'recent' | 'stale' | 'dead' | 'never';

export interface Freshness {
  level: FreshnessLevel;
  label: string;      // "12s ago", "3m ago", "Never"
  ageMs: number | null;
}

const FRESH_LIVE_MS = 30_000;      // < 30s = live (green)
const FRESH_RECENT_MS = 5 * 60_000; // < 5m = recent (neutral)
const FRESH_STALE_MS = 60 * 60_000; // < 1h = stale (amber); beyond = dead (red)

/** Human age label for a millisecond age. */
export function formatAge(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Classify how fresh a timestamp is relative to `nowMs` (injectable for tests).
 * Invalid/absent timestamps → 'never'.
 */
export function tickFreshness(iso: string | null | undefined, nowMs: number = Date.now()): Freshness {
  if (!iso) return { level: 'never', label: 'Never', ageMs: null };
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { level: 'never', label: 'Never', ageMs: null };
  const ageMs = Math.max(0, nowMs - t);
  const label = formatAge(ageMs);
  if (ageMs < FRESH_LIVE_MS) return { level: 'live', label, ageMs };
  if (ageMs < FRESH_RECENT_MS) return { level: 'recent', label, ageMs };
  if (ageMs < FRESH_STALE_MS) return { level: 'stale', label, ageMs };
  return { level: 'dead', label, ageMs };
}

/** Tailwind text color class per freshness level (dark theme conventions). */
export function freshnessColor(level: FreshnessLevel): string {
  switch (level) {
    case 'live': return 'text-[#5DBE81]';
    case 'recent': return 'text-[#8A9BA8]';
    case 'stale': return 'text-[#facc15]';
    case 'dead': return 'text-[#ef4444]';
    case 'never': return 'text-[#8A9BA8]';
  }
}

/** Tailwind classes for the status pill in the watcher health card. */
export function statusPillClasses(level: WatcherStatusLevel): string {
  switch (level) {
    case 'ok': return 'bg-[#5DBE81]/15 text-[#5DBE81] border-[#5DBE81]/30';
    case 'degraded': return 'bg-[#facc15]/15 text-[#facc15] border-[#facc15]/30';
    case 'stalled': return 'bg-[#f97316]/15 text-[#f97316] border-[#f97316]/30';
    case 'down': return 'bg-[#ef4444]/15 text-[#ef4444] border-[#ef4444]/30';
  }
}

/* ─────────────────── HOT tier set helper ─────────────────── */

/**
 * Build a Set of HOT pair ids from the /api/watcher/tiers response.
 * Tolerant of malformed rows — anything without a string pairId is skipped.
 */
export function hotPairIdSet(tierState: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(tierState)) return out;
  for (const row of tierState) {
    if (row && typeof row === 'object'
      && (row as Record<string, unknown>).tier === 'hot'
      && typeof (row as Record<string, unknown>).pairId === 'string') {
      out.add((row as Record<string, unknown>).pairId as string);
    }
  }
  return out;
}
