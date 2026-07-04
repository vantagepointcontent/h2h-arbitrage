/**
 * Tiny in-process TTL cache with in-flight request dedup (PERF-P0).
 *
 * Used to memoize upstream gamma/Kalshi metadata fetches so that the poller,
 * UI-triggered scans, and background refreshes hitting the SAME upstream URL
 * within a few seconds share one HTTP request instead of stampeding.
 *
 * NOT for orderbook/price freshness-critical paths — Live WS keeps its own
 * REST-seed + WS-delta pipeline. Gamma event metadata and Kalshi market lists
 * change slowly; a 10s TTL is safe and cuts 1-2s off typical scans.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const MAX_ENTRIES = 500;

export function createTtlMemo<T>(ttlMs: number) {
  const cache = new Map<string, Entry<T>>();
  const inflight = new Map<string, Promise<T>>();

  function evictIfNeeded() {
    if (cache.size <= MAX_ENTRIES) return;
    const now = Date.now();
    for (const [k, e] of cache) {
      if (e.expiresAt <= now) cache.delete(k);
    }
    // Still too big — drop oldest insertion order
    while (cache.size > MAX_ENTRIES) {
      const k = cache.keys().next().value as string | undefined;
      if (k === undefined) break;
      cache.delete(k);
    }
  }

  return async function memo(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const pending = inflight.get(key);
    if (pending) return pending;

    const p = fn()
      .then((value) => {
        cache.set(key, { value, expiresAt: Date.now() + ttlMs });
        evictIfNeeded();
        return value;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, p);
    return p;
  };
}
