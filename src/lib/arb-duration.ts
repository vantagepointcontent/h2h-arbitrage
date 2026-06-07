"use client";

// ── Storage key ──
const ARB_DURATIONS_KEY = "h2h-arb-durations";

/**
 * Track first-detection timestamps for arbitrage opportunities.
 * Persists to sessionStorage so duration survives page reloads within the session.
 */

export interface ArbDurationEntry {
  marketId: string;
  firstDetectedMs: number;
  lastSeenMs: number;
}

/** Load all duration entries from sessionStorage */
export function loadArbDurations(): Map<string, ArbDurationEntry> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = sessionStorage.getItem(ARB_DURATIONS_KEY);
    if (!raw) return new Map();
    const entries: ArbDurationEntry[] = JSON.parse(raw);
    return new Map(entries.map((e) => [e.marketId, e]));
  } catch {
    return new Map();
  }
}

/** Persist all duration entries to sessionStorage */
function persistArbDurations(map: Map<string, ArbDurationEntry>): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(
      ARB_DURATIONS_KEY,
      JSON.stringify(Array.from(map.values())),
    );
  } catch {
    /* quota exceeded – ignore */
  }
}

/**
 * Record or update the duration for a market.
 * If the market has an active arb (roi > 0), records first detection.
 * If not, removes the entry.
 */
export function updateArbDuration(
  marketId: string,
  hasArb: boolean,
): Map<string, ArbDurationEntry> {
  const map = loadArbDurations();
  const now = Date.now();

  if (hasArb) {
    const existing = map.get(marketId);
    if (existing) {
      // Already tracked — just update last seen
      existing.lastSeenMs = now;
      map.set(marketId, existing);
    } else {
      // First detection
      map.set(marketId, { marketId, firstDetectedMs: now, lastSeenMs: now });
    }
  } else {
    // No arb — remove tracking
    map.delete(marketId);
  }

  persistArbDurations(map);
  return map;
}

/** Get the duration string for a market */
export function getArbDurationString(
  marketId: string,
): string | null {
  const entry = loadArbDurations().get(marketId);
  if (!entry) return null;
  return formatDuration(Date.now() - entry.firstDetectedMs);
}

/** Get the color class based on duration (fresh=green, aged=amber) */
export function getArbDurationColor(
  marketId: string,
): "green" | "yellow" | "red" | null {
  const entry = loadArbDurations().get(marketId);
  if (!entry) return null;
  const ms = Date.now() - entry.firstDetectedMs;
  if (ms < 300000) return "green"; // < 5 min
  if (ms < 1800000) return "yellow"; // 5-30 min
  return "red"; // 30+ min
}

/**
 * Format milliseconds into a human-readable duration string.
 * Formats: "< 1m", "5m", "2h 30m", "1d 4h"
 */
export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return "< 1m";

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours < 24) {
    return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0
    ? `${days}d ${remainHours}h`
    : `${days}d`;
}

/**
 * Bulk-update durations from a list of markets with their ROI data.
 * Call this after scan/poll to sync tracking state.
 */
export function syncArbDurations(
  markets: Array<{ id: string; hasArb: boolean }>,
): Map<string, ArbDurationEntry> {
  const map = loadArbDurations();
  const now = Date.now();
  const activeIds = new Set<string>();

  for (const m of markets) {
    if (m.hasArb) {
      activeIds.add(m.id);
      const existing = map.get(m.id);
      if (existing) {
        existing.lastSeenMs = now;
      } else {
        map.set(m.id, { marketId: m.id, firstDetectedMs: now, lastSeenMs: now });
      }
    }
  }

  // Remove entries for markets that no longer have arb
  for (const [id] of map) {
    if (!activeIds.has(id)) {
      map.delete(id);
    }
  }

  persistArbDurations(map);
  return map;
}
