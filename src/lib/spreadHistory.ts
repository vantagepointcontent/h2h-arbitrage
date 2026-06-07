// IndexedDB persistence for historical spread data
// Stores per-market spread samples every ~30s for charting (24h / 7d / 30d)

const DB_NAME = "h2h-spread-history";
const DB_VERSION = 1;
const STORE_NAME = "spreads";

export interface SpreadPoint {
  ts: number;           // epoch ms
  marketId: string;     // saved market id
  kalshiYesBid: number;
  kalshiYesAsk: number;
  pmYesBid: number;     // bestBid from polymarket
  pmYesAsk: number;     // bestAsk from polymarket
  spread: number;       // best arbitrage spread (percentage points)
  strategy: string;     // e.g. "buy_k_yes_sell_pm_yes"
  roiPct: number;       // ROI percentage
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (evt: any) => {
      const db = evt.target.result as IDBDatabase;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("marketId_ts", ["marketId", "ts"], { unique: false });
        store.createIndex("ts_marketId", ["ts", "marketId"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Generate a unique id for a spread point */
function pointId(marketId: string, ts: number): string {
  return `${marketId}:${ts}`;
}

/** Save a single spread point */
export async function saveSpread(point: SpreadPoint): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    point.id = pointId(point.marketId, point.ts);
    store.put(point);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Retrieve spread points for a market within a time window */
export async function getSpreads(
  marketId: string,
  fromMs: number,
  toMs: number,
): Promise<SpreadPoint[]> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("marketId_ts");
    // Range: [marketId, fromMs] to [marketId, toMs]
    const range = IDBKeyRange.bound([marketId, fromMs], [marketId, toMs]);
    const req = index.getAll(range);
    req.onsuccess = () => resolve(req.result as SpreadPoint[]);
    req.onerror = () => resolve([]);
  });
}

/** Delete all spread data for a market */
export async function clearMarketSpreads(marketId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("marketId_ts");
    const range = IDBKeyRange.only(marketId);
    // We need to iterate because we can't delete by composite key range easily
    const req = index.openCursor(IDBKeyRange.only([marketId]));
    const toDelete: IDBKeyRange[] = [];
    req.onsuccess = (evt: any) => {
      const cursor = evt.target.result;
      if (cursor) {
        toDelete.push(cursor.primaryKey);
        cursor.continue();
      } else {
        // Delete all collected
        for (const key of toDelete) {
          store.delete(key);
        }
        tx.oncomplete = () => resolve();
      }
    };
    tx.onerror = () => reject(tx.error);
  });
}

/** Get the oldest stored timestamp for a market (to know how far back data goes) */
export async function getOldestTimestamp(marketId: string): Promise<number | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("marketId_ts");
    const range = IDBKeyRange.bound([marketId, -Infinity], [marketId, Infinity]);
    const req = index.openCursor(range);
    req.onsuccess = (evt: any) => {
      const cursor = evt.target.result;
      if (cursor) {
        resolve(cursor.primaryKey[1] as number);
      } else {
        resolve(null);
      }
    };
    req.onerror = () => resolve(null);
  });
}

/** Prune old data beyond retention window (default: 60 days) */
export async function pruneOldData(marketId: string, retentionMs: number = 60 * 86400000): Promise<number> {
  const cutoff = Date.now() - retentionMs;
  const db = await openDb();
  let deleted = 0;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("marketId_ts");
    const range = IDBKeyRange.bound([marketId, -Infinity], [marketId, cutoff]);
    const req = index.openCursor(range);
    req.onsuccess = (evt: any) => {
      const cursor = evt.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        deleted++;
        cursor.continue();
      } else {
        tx.oncomplete = () => resolve(deleted);
      }
    };
    tx.onerror = () => reject(tx.error);
  });
}

/** Time range presets in milliseconds */
export const TIME_RANGES = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const;

export type TimeRange = keyof typeof TIME_RANGES;
