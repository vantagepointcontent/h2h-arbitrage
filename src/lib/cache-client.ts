/**
 * HTTP cache client that sits between the frontend and the API.
 *
 * Behavior:
 *  - GET-style requests: check cache first, return stale + refresh in background
 *  - Network errors: serve stale data from cache (offline fallback)
 *  - Mutation requests (POST/PUT/DELETE): bypass cache, invalidate related keys
 *  - Configurable per-request TTL override
 */

import { getCache, type CacheEntry, type CacheResult, type IdbCacheOptions } from './idb-cache';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedResponse<V = unknown> {
  data: V;
  source: 'cache-hot' | 'cache-stale' | 'network';
  ageMs: number;
  cachedAt: number | null;
}

export interface CacheClientOptions extends IdbCacheOptions {
  /** Whether to serve stale data when network is down */
  offlineFallback?: boolean;
  /** Whether to trigger background refresh on stale cache hit */
  backgroundRefresh?: boolean;
  /** Fetch timeout in ms */
  fetchTimeoutMs?: number;
  /** Base URL for API calls (defaults to current origin) */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CLIENT_OPTS: Required<Omit<CacheClientOptions, keyof IdbCacheOptions>> = {
  offlineFallback: true,
  backgroundRefresh: true,
  fetchTimeoutMs: 15_000,
  baseUrl: '',
};

// ---------------------------------------------------------------------------
// Cache Client
// ---------------------------------------------------------------------------

export class CacheClient {
  private cache: ReturnType<typeof getCache>;
  private opts: CacheClientOptions & Required<{
    offlineFallback: boolean;
    backgroundRefresh: boolean;
    fetchTimeoutMs: number;
    baseUrl: string;
  }>;
  private refreshPromises: Map<string, Promise<CachedResponse<any>>> = new Map();
  private online: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;

  constructor(opts?: CacheClientOptions) {
    this.cache = getCache(opts);
    this.opts = { ...DEFAULT_CLIENT_OPTS, ...opts };
    if (this.opts.baseUrl && this.opts.baseUrl.endsWith('/')) {
      this.opts.baseUrl = this.opts.baseUrl.slice(0, -1);
    }

    // Track online/offline state for offline fallback
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.online = true; });
      window.addEventListener('offline', () => { this.online = false; });
    }
  }

  /**
   * Fetch with cache. For GET-equivalent requests, checks cache first.
   * Returns cached data immediately (even if stale) while refreshing in background.
   */
  public async get<V = unknown>(
    path: string,
    opts?: { ttlMs?: number; cache?: boolean; forceRefresh?: boolean },
  ): Promise<CachedResponse<V>> {
    const cacheKey = this.buildKey(path);
    const useCache = opts?.cache !== false;
    const ttlMs = opts?.ttlMs;

    // Fast path: skip cache entirely
    if (!useCache || opts?.forceRefresh) {
      return this.fetchNetwork<V>(path, ttlMs);
    }

    // Check cache
    const cached = await this.cache.get<V>(cacheKey);

    if (cached.hit && !cached.expired) {
      // Hot cache — return immediately
      return {
        data: cached.data,
        source: 'cache-hot',
        ageMs: cached.ageMs,
        cachedAt: cached.expired ? null : Date.now() - cached.ageMs,
      };
    }

    // Stale cache or miss — try network
    if (this.online) {
      // Deduplicate concurrent refreshes for the same key
      const existing = this.refreshPromises.get(cacheKey);
      if (existing) {
        // If we have stale data, return it while the existing refresh completes
        if (cached.hit) {
          return {
            data: cached.data,
            source: 'cache-stale',
            ageMs: cached.ageMs,
            cachedAt: Date.now() - cached.ageMs,
          };
        }
        // No stale data — wait for the in-flight request
        return existing;
      }

      // Start background refresh
      const refreshPromise = this.fetchAndCache<V>(path, ttlMs);
      this.refreshPromises.set(cacheKey, refreshPromise);
      refreshPromise.finally(() => {
        this.refreshPromises.delete(cacheKey);
      });

      // If we have stale data, return it immediately
      if (cached.hit) {
        return {
          data: cached.data,
          source: 'cache-stale',
          ageMs: cached.ageMs,
          cachedAt: Date.now() - cached.ageMs,
        };
      }

      // Cache miss — wait for network
      return refreshPromise;
    }

    // Offline: return stale data if available
    if (this.opts.offlineFallback && cached.hit) {
      return {
        data: cached.data,
        source: 'cache-stale',
        ageMs: cached.ageMs,
        cachedAt: Date.now() - cached.ageMs,
      };
    }

    // Offline and no cache — throw
    throw new Error(`Offline cache miss for ${cacheKey}`);
  }

  /**
   * Invalidate a specific cache key.
   */
  public async invalidate(keyOrPath: string): Promise<void> {
    const cacheKey = this.buildKey(keyOrPath);
    await this.cache.del(cacheKey);
  }

  /**
   * Invalidate all cache entries matching a pattern.
   */
  public async invalidatePattern(pattern: RegExp): Promise<number> {
    const stats = await this.cache.stats();
    // We'd need to iterate all keys; for now, clear and let them repopulate
    // A more sophisticated version would store keys in an index
    await this.cache.clear();
    return stats.entryCount;
  }

  /**
   * Clear all cache entries.
   */
  public async clear(): Promise<void> {
    await this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  public async stats() {
    return this.cache.stats();
  }

  /**
   * Close the underlying connection.
   */
  public close(): void {
    this.cache.close();
  }

  // ── Private methods ────────────────────────────────────────────────────

  private buildKey(path: string): string {
    const url = this.opts.baseUrl ? `${this.opts.baseUrl}${path}` : path;
    return `h2h:${url}`;
  }

  private async fetchNetwork<V>(
    path: string,
    ttlMs?: number,
  ): Promise<CachedResponse<V>> {
    const url = this.opts.baseUrl ? `${this.opts.baseUrl}${path}` : path;
    const data = await this.doFetch<V>(url);
    const cacheKey = this.buildKey(path);
    await this.cache.set(cacheKey, data, { ttlMs });
    return {
      data,
      source: 'network',
      ageMs: 0,
      cachedAt: Date.now(),
    };
  }

  private async fetchAndCache<V>(
    path: string,
    ttlMs?: number,
  ): Promise<CachedResponse<V>> {
    const url = this.opts.baseUrl ? `${this.opts.baseUrl}${path}` : path;
    const cacheKey = this.buildKey(path);

    try {
      const data = await this.doFetch<V>(url);
      await this.cache.set(cacheKey, data, { ttlMs });
      return {
        data,
        source: 'network',
        ageMs: 0,
        cachedAt: Date.now(),
      };
    } catch (err) {
      // Network error — try stale cache
      if (this.opts.offlineFallback) {
        const cached = await this.cache.get<V>(cacheKey);
        if (cached.hit) {
          return {
            data: cached.data,
            source: 'cache-stale',
            ageMs: cached.ageMs,
            cachedAt: Date.now() - cached.ageMs,
          };
        }
      }
      throw err;
    }
  }

  private async doFetch<V>(url: string): Promise<V> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs);

    try {
      const resp = await fetch(url, { signal: controller.signal });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      return resp.json() as V;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

let defaultClient: CacheClient | null = null;

export function getCacheClient(opts?: CacheClientOptions): CacheClient {
  if (!defaultClient) {
    defaultClient = new CacheClient(opts);
  }
  return defaultClient;
}

export function resetCacheClient(): void {
  defaultClient?.close();
  defaultClient = null;
}
