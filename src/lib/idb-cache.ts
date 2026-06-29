/**
 * IndexedDB cache layer for market data.
 *
 * Features:
 *  - TTL-based invalidation (default 30s)
 *  - LRU eviction with configurable size cap
 *  - Stale-data fallback when network is unavailable
 *  - Background refresh hooks (listeners on cache misses/expiries)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheEntry<V = unknown> {
  /** Unique cache key (typically the API URL or a semantic identifier) */
  key: string;
  /** Cached response payload */
  data: V;
  /** Epoch ms when this entry was inserted */
  insertedAt: number;
  /** Epoch ms of last read — drives LRU eviction */
  accessedAt: number;
  /** Per-entry TTL in ms (defaults to global ttlMs if not overridden) */
  ttlMs: number;
  /** Approximate byte size of JSON.stringify(data) — used for size-cap eviction */
  sizeBytes: number;
  /** HTTP status code of the original response (200, 404, etc.) */
  statusCode: number;
}

export interface IdbCacheOptions {
  /** Database name */
  dbName?: string;
  /** Object store name */
  storeName?: string;
  /** Default TTL in milliseconds */
  ttlMs?: number;
  /** Maximum number of entries before LRU eviction kicks in */
  maxSize?: number;
  /** Maximum total size in bytes before LRU eviction kicks in */
  maxBytes?: number;
  /** Version number — increment to trigger upgrade migration */
  dbVersion?: number;
}

export interface CacheHit<V = unknown> {
  hit: true;
  data: V;
  ageMs: number;
  expired: boolean;
}

export interface CacheMiss {
  hit: false;
}

export type CacheResult<V> = CacheHit<V> | CacheMiss;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: Required<IdbCacheOptions> = {
  dbName: 'h2h-market-cache',
  storeName: 'snapshots',
  ttlMs: 30_000,       // 30 seconds
  maxSize: 200,         // up to 200 entries
  maxBytes: 50 * 1024 * 1024, // 50 MB
  dbVersion: 1,
};

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

class IdbCache {
  private opts: Required<IdbCacheOptions>;
  private db: IDBDatabase | null = null;
  private initPromise: Promise<IDBDatabase>;
  private listeners: Set<(key: string) => void> = new Set();
  private evictedListeners: Set<(entry: CacheEntry, reason: 'ttl' | 'size' | 'evict') => void> = new Set();

  constructor(opts?: IdbCacheOptions) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.initPromise = this.openDb();
  }

  // ── Database lifecycle ────────────────────────────────────────────────

  private async openDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.opts.dbName, this.opts.dbVersion);

      req.onupgradeneeded = (evt) => {
        const db = (evt.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.opts.storeName)) {
          const store = db.createObjectStore(this.opts.storeName, { keyPath: 'key' });
          store.createIndex('accessedAt', 'accessedAt', { unique: false });
          store.createIndex('insertedAt', 'insertedAt', { unique: false });
        }
      };

      req.onsuccess = () => {
        this.db = req.result;
        this.db.onclose = () => { this.db = null; };
        resolve(this.db!);
      };

      req.onerror = () => reject(req.error);
    });
  }

  public close(): void {
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }

  // ── Core operations ───────────────────────────────────────────────────

  /**
   * Get a cached entry. Returns a CacheHit (possibly expired) or CacheMiss.
   * Updates accessedAt on every read for accurate LRU tracking.
   */
  public async get<V = unknown>(key: string): Promise<CacheResult<V>> {
    const db = await this.initPromise;
    return new Promise((resolve) => {
      const tx = db.transaction(this.opts.storeName, 'readwrite');
      const store = tx.objectStore(this.opts.storeName);
      const req = store.get(key);

      req.onsuccess = () => {
        const entry = req.result as CacheEntry<V> | undefined;
        if (!entry) {
          resolve({ hit: false });
          return;
        }
        const now = Date.now();
        const ageMs = now - entry.insertedAt;
        const expired = ageMs > entry.ttlMs;

        // Update access time for LRU tracking
        entry.accessedAt = now;
        store.put(entry);

        resolve({
          hit: true,
          data: entry.data,
          ageMs,
          expired,
        });
      };

      req.onerror = () => resolve({ hit: false });
    });
  }

  /**
   * Set a cache entry. Evicts LRU entries if size/byte caps are exceeded.
   */
  public async set<V = unknown>(
    key: string,
    data: V,
    opts?: { ttlMs?: number; statusCode?: number },
  ): Promise<void> {
    const db = await this.initPromise;
    const sizeBytes = estimateBytes(data);
    const ttlMs = opts?.ttlMs ?? this.opts.ttlMs;
    const now = Date.now();

    const entry: CacheEntry<V> = {
      key,
      data,
      insertedAt: now,
      accessedAt: now,
      ttlMs,
      sizeBytes,
      statusCode: opts?.statusCode ?? 200,
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.opts.storeName, 'readwrite');
      const store = tx.objectStore(this.opts.storeName);
      store.put(entry);

      tx.oncomplete = () => {
        // Check caps and evict if needed
        this.evictIfNeeded(db).then(resolve, reject);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Delete a cache entry by key.
   */
  public async del(key: string): Promise<boolean> {
    const db = await this.initPromise;
    return new Promise((resolve) => {
      const tx = db.transaction(this.opts.storeName, 'readwrite');
      const store = tx.objectStore(this.opts.storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve(req.result ?? true);
      req.onerror = () => resolve(false);
    });
  }

  /**
   * Clear the entire cache.
   */
  public async clear(): Promise<void> {
    const db = await this.initPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.opts.storeName, 'readwrite');
      const store = tx.objectStore(this.opts.storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get cache statistics.
   */
  public async stats(): Promise<{
    entryCount: number;
    totalBytes: number;
    oldestAgeMs: number;
    hitRate: number;
  }> {
    const db = await this.initPromise;
    return new Promise((resolve) => {
      const tx = db.transaction(this.opts.storeName, 'readonly');
      const store = tx.objectStore(this.opts.storeName);
      const req = store.getAll();

      req.onsuccess = () => {
        const entries = req.result as CacheEntry[];
        const now = Date.now();
        const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
        const ages = entries.map((e) => now - e.insertedAt);
        resolve({
          entryCount: entries.length,
          totalBytes,
          oldestAgeMs: ages.length > 0 ? Math.max(...ages) : 0,
          hitRate: 0, // Would need external tracking for accurate hit rate
        });
      };

      req.onerror = () => resolve({
        entryCount: 0,
        totalBytes: 0,
        oldestAgeMs: 0,
        hitRate: 0,
      });
    });
  }

  // ── LRU eviction ────────────────────────────────────────────────────────

  /**
   * Evict LRU entries until count and byte caps are satisfied.
   */
  private async evictIfNeeded(db: IDBDatabase): Promise<void> {
    const tx = db.transaction(this.opts.storeName, 'readwrite');
    const store = tx.objectStore(this.opts.storeName);
    const index = store.index('accessedAt');

    // Collect all entries sorted by accessedAt (oldest first = LRU)
    const all: CacheEntry[] = [];
    const req = index.getAll();
    await new Promise<void>((resolve) => {
      req.onsuccess = () => {
        all.push(...req.result);
        resolve();
      };
      req.onerror = () => resolve();
    });

    all.sort((a, b) => a.accessedAt - b.accessedAt);

    // Evict until under both caps
    const toEvict: CacheEntry[] = [];
    let remainingBytes = all.reduce((s, e) => s + e.sizeBytes, 0);

    for (const entry of all) {
      if (all.length - toEvict.length > this.opts.maxSize) {
        toEvict.push(entry);
        remainingBytes -= entry.sizeBytes;
        continue;
      }
      if (remainingBytes > this.opts.maxBytes) {
        toEvict.push(entry);
        remainingBytes -= entry.sizeBytes;
        continue;
      }
      break;
    }

    // Also evict expired entries
    const now = Date.now();
    for (const entry of all) {
      if (!toEvict.includes(entry) && (now - entry.insertedAt) > entry.ttlMs) {
        toEvict.push(entry);
      }
    }

    // Remove evicted entries
    for (const entry of toEvict) {
      store.delete(entry.key);
    }
    for (const cb of [...this.evictedListeners]) {
      for (const entry of toEvict) {
        cb(entry, 'evict');
      }
    }
  }

  // ── Listeners (background refresh hooks) ──────────────────────────────

  /**
   * Register a listener that fires on cache miss or expiry.
   * Use this to trigger background refresh.
   */
  public onMiss(fn: (key: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Register a listener that fires when entries are evicted.
   */
  public onEvicted(fn: (entry: CacheEntry, reason: 'ttl' | 'size' | 'evict') => void): () => void {
    this.evictedListeners.add(fn);
    return () => this.evictedListeners.delete(fn);
  }

  /**
   * Notify listeners of a cache miss (call from the cache client).
   */
  public notifyMiss(key: string): void {
    for (const fn of [...this.listeners]) {
      try { fn(key); } catch { /* swallow listener errors */ }
    }
  }

  /**
   * Purge entries older than maxAgeMs.
   */
  public async purge(maxAgeMs: number): Promise<number> {
    const db = await this.initPromise;
    const cutoff = Date.now() - maxAgeMs;
    let purged = 0;

    return new Promise((resolve) => {
      const tx = db.transaction(this.opts.storeName, 'readwrite');
      const store = tx.objectStore(this.opts.storeName);
      const req = store.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const entry = cursor.value as CacheEntry;
          if (entry.insertedAt < cutoff) {
            cursor.delete();
            purged++;
          }
          cursor.continue();
        } else {
          resolve(purged);
        }
      };
      req.onerror = () => resolve(purged);
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateBytes(data: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(data)).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance (default cache for market data)
// ---------------------------------------------------------------------------

let defaultCache: IdbCache | null = null;

export function getCache(opts?: IdbCacheOptions): IdbCache {
  if (!defaultCache) {
    defaultCache = new IdbCache(opts);
  }
  return defaultCache;
}

/**
 * Reset the singleton — useful for testing.
 */
export function resetCache(): void {
  defaultCache?.close();
  defaultCache = null;
}
