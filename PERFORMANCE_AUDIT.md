# EdgeFinder Performance Audit — Findings

> **Scope**: `/home/scott/h2h-arbitrage` — Next.js app (EdgeFinder prediction-market arbitrage scanner)
> **DB**: `data/edgefinder.db` (30 MB, 34.5k scan_results rows, 300+ saved_markets)
> **JSON**: `data/saved-markets.json` (745 KB, 21 467 lines)
> **Mode**: Read-only audit. No files modified.

---

## P0 — Critical (fix immediately, each blocks scan latency)

### 1. SQLite: No WAL mode, no synchronous pragma

**File**: `src/lib/persistence.ts` line 17 (and duplicated in `settings.ts` line 21, `arb-lifecycle.ts` line 25, `watch-targets.ts` line 18)
**Problem**: Every libSQL client opens the DB with default journal mode (`delete`) and `synchronous = FULL`. No `PRAGMA journal_mode = WAL` or `PRAGMA synchronous = OFF` (or `NORMAL`) anywhere. WAL mode enables concurrent readers/writers (critical with poller + Next.js + ws-watcher all writing the same file). FULL synchronous fsyncs on every transaction — unnecessary for a scanner app where data loss tolerance is low but write latency matters.
**Cost**: Every write blocks all readers for the duration of the fsync. With 300+ markets each poll cycle, this adds **50–200 ms per write** × writes per cycle. WAL mode alone typically gives 2–5× read throughput improvement; combined with `synchronous = OFF` it eliminates fsync overhead entirely.
**Fix**: Add to every `getClient()`:
```ts
await _client.execute('PRAGMA journal_mode = WAL');
await _client.execute('PRAGMA synchronous = OFF'); // scanner app — data loss tolerance
```

### 2. `/api/logs` fetches 10 000 rows then filters in-app

**File**: `src/app/api/logs/route.ts` line 28
**Problem**: Comment says "fetch generous pool then filter in-app". The `minRoi`, `positiveArbOnly`, `fromDate`, `toDate` filters are all applied in JavaScript after pulling up to 10 000 rows. With 34.5k rows in the DB, this means every logs request loads the entire table (or a large slice) into memory, deserializes every row, then discards most of it.
**Cost**: Measured ~152 ms per the comment. With 34.5k rows, `getScanHistory` pulls all of them. Each row includes `raw_result` (full JSON payload) — estimated **~2–4 MB** of data transferred per call.
**Fix**: Move filters into SQL with `WHERE` clauses and proper indexes:
```ts
// In persistence.ts getScanHistory():
let sql = 'SELECT * FROM scan_results WHERE 1=1';
const args: (string | number)[] = [];
if (minRoi !== undefined) { sql += ' AND best_roi_pct >= ?'; args.push(minRoi); }
if (positiveArbOnly) { sql += ' AND positive_arb_count > 0'; }
if (fromDate) { sql += ' AND scanned_at >= ?'; args.push(fromDate); }
if (toDate) { sql += ' AND scanned_at <= ?'; args.push(toDate); }
sql += ' ORDER BY scanned_at DESC LIMIT ?';
args.push(limit);
```
Add index: `CREATE INDEX idx_scan_results_roi ON scan_results(best_roi_pct);`
**Expected**: < 5 ms for filtered queries vs 150+ ms unfiltered.

### 3. `/api/dashboard/stats` fetches 20 000 rows then filters in-app

**File**: `src/app/api/dashboard/stats/route.ts` line 44
**Problem**: Same pattern as #2. Pulls 20k rows, then filters by date range in JS, then does O(n²) scans-per-day grouping (line 87: `rows.filter(...)` inside a 30-iteration loop).
**Cost**: **300–600 ms** per dashboard load (20k rows × 30 daily groupings × filter overhead).
**Fix**: Push date filtering and aggregation into SQL:
```sql
SELECT DATE(scanned_at) as day, COUNT(*) as count,
       AVG(best_roi_pct) as avg_roi, SUM(best_profit) as total_profit
FROM scan_results
WHERE scanned_at >= ?
GROUP BY DATE(scanned_at)
ORDER BY day;
```
**Expected**: < 50 ms.

### 4. No in-process cache on Kalshi / Polymarket gamma fetches

**File**: `src/lib/kalshi.ts` lines 86, 98, 110 — all `cache: 'no-store'`
**File**: `src/lib/polymarket.ts` lines 61, 87, 110 — all `cache: 'no-store'`
**Problem**: Every scan request (from UI or poller) makes fresh HTTP requests to Kalshi and Polymarket gamma APIs. No in-process TTL cache. The CLOB layer (`polymarket-clob.ts`) already has a 2-second in-memory cache (line 67) — the same pattern should apply to gamma and Kalshi.
**Cost**: Each scan makes 2–4 upstream HTTP requests (Kalshi event + series fallbacks + PM gamma). Each request adds **500–2000 ms** of network latency. For the poller running every 60s across 300+ markets, this means **600+ upstream requests per cycle** that could be cached.
**Fix**: Add a shared TTL cache (like CLOB's 2-second cache):
```ts
// In kalshi.ts — add near top:
const kalshiCache = new Map<string, { data: any; expires: number }>();
const KALSHI_CACHE_TTL_MS = 5000; // 5s

function getCached(key: string): any {
  const e = kalshiCache.get(key);
  if (e && Date.now() < e.expires) return e.data;
  kalshiCache.delete(key);
  return null;
}
function setCached(key: string, data: any) {
  kalshiCache.set(key, { data, expires: Date.now() + KALSHI_CACHE_TTL_MS });
}
// Then in fetchKalshiEventMarkets(): check cache before fetch, set after.
```
**Expected**: For the poller, same market scanned within 5s hits cache → saves **~1–2 s per scan**.

---

## P1 — High (significant impact, moderate effort)

### 5. `mirrorMarketsToJson()` reads entire 745 KB saved-markets.json on every write

**File**: `src/lib/persistence.ts` lines 325–336
**Problem**: Every `archiveSavedMarket`, `unarchiveSavedMarket`, `addSavedMarket`, `upsertSavedMarket`, `updateSavedMarketScanResult`, `updateSavedMarket` calls `mirrorMarketsToJson()`, which calls `getSavedMarkets()` (full DB SELECT *), then writes 745 KB to disk. This happens on EVERY mutation.
**Cost**: **50–150 ms** per write (full DB read + JSON serialization + disk write). If a scan updates a market's scan result, the full 745 KB is read and rewritten.
**Fix**: Use a targeted JSON update instead of read-modify-write:
```ts
// Write a small atomic JSON update file with just the changed market
// Or: skip the JSON mirror for liveResult updates (already done for updateSavedMarketLiveResult)
// For regular mutations, write only the changed market to a delta file,
// and have the poller merge deltas on read.
```
Simplest: Don't mirror for `updateSavedMarketScanResult` — the poller already reads the DB directly now. Keep the JSON mirror only for manual CRUD (add/archive/delete).

### 6. `/api/saved-markets` `fields=basic` mode not implemented

**File**: `src/app/api/saved-markets/route.ts` lines 8–21
**Problem**: The route accepts a `fields` query parameter. Only `names` (line 12) and the default `full` (line 23) are handled. `fields=basic` is documented but falls through to `full` — returning the entire 574 KB payload.
**Cost**: Every call that expects `basic` (likely the dashboard or overview page) gets 574 KB instead of ~20 KB.
**Fix**: Implement `basic` mode:
```ts
if (fields === 'basic') {
  const basic = markets.map((m: any) => ({
    id: m.id, eventTitle: m.eventTitle, category: m.category,
    bestRoiPct: m.lastScanResult?.bestRoiPct ?? 0,
    bestProfit: m.lastScanResult?.bestProfit ?? 0,
    strategy: m.lastScanResult?.strategy ?? '',
    scannedAt: m.lastScanResult?.scannedAt,
    matchedCount: m.lastScanResult?.matchedCount ?? 0,
    archived: m.archived, favorite: m.favorite,
  }));
  return NextResponse.json({ markets: basic });
}
```

### 7. `/api/scan` calls `getSavedMarkets()` to look up one market

**File**: `src/app/api/scan/route.ts` line 300
**Problem**: `const allMarkets = await getSavedMarkets();` loads ALL 300+ saved markets into memory just to find one by URL match (`m.kalshiUrl === kalshiUrl`). Then line 70 in logs route does the same for name resolution.
**Cost**: **50–100 ms** per scan request (full DB read + row parsing + JSON parse of lastScanResult for every row).
**Fix**: Add a targeted DB query:
```ts
// In persistence.ts:
export async function getSavedMarketByUrl(kalshiUrl: string, polymarketUrl: string): Promise<SavedMarket | null> {
  await ensureMarketsMigrated();
  const c = getClient();
  const res = await c.execute(
    'SELECT * FROM saved_markets WHERE kalshi_url = ? OR polymarket_url = ? LIMIT 1',
    [kalshiUrl, polymarketUrl]
  );
  const rows = (res.rows as any[]);
  return rows.length ? rowToMarket(rows[0]) : null;
}
```

### 8. PM gamma fetch has no deduplication during a single scan

**File**: `src/lib/polymarket.ts` line 55–69
**Problem**: `fetchPolymarketEvent(slug)` uses `cache: 'no-store'` with no in-process cache. During a scan with 5–20 Polymarket condition IDs, the same event slug may be fetched multiple times (e.g., `fetchPolymarketMarketAsEvent` fetches the market, then fetches the event). The `/api/scan` route fetches Kalshi 3 ways sequentially (event → series_prefix → series_ticker), each taking 500–2000 ms.
**Cost**: **2–5 seconds** of sequential upstream latency per scan request.
**Fix**: Same TTL cache pattern as #4. Additionally, deduplicate PM event fetches within a single scan using a request-scoped promise map.

---

## P2 — Medium (good improvements, lower effort)

### 9. CLOB 2-second cache is too short for poller burst

**File**: `src/lib/polymarket-clob.ts` line 30
**Problem**: `CLOB_CACHE_TTL_MS = 2000`. The poller scans 300+ markets with concurrency 5. Within a 5-second window, the same condition IDs are fetched repeatedly by different markets in the same poll cycle. The CLOB cache helps within a single scan but not across scans.
**Fix**: Increase to 10–15 seconds. CLOB prices change on the order of seconds; 15s is still fresh for arbitrage detection.
```ts
const CLOB_CACHE_TTL_MS = 15000; // was 2000
```

### 10. `/api/scan` response includes full `allArbs` in `raw` column

**File**: `src/app/api/scan/route.ts` line 358
**Problem**: `raw: { allArbs: scanResult.allArbs }` is stored in SQLite's `raw_result` column for every scan. This duplicates data already in `positive_arb_count` and `best_profit`. The `raw_result` column grows unbounded and contributes to the 30 MB DB size.
**Cost**: Each `raw_result` blob is ~1–5 KB. With 34.5k rows, that's **35–170 MB** of redundant data (the DB file is 30 MB compressed, but the actual data is larger).
**Fix**: Store only a hash or skip `raw_result` entirely if the full data is available elsewhere. Or cap the column at N bytes.

### 11. `appendScanHistory` bounded delete is O(n)

**File**: `src/lib/persistence.ts` line 577
**Problem**: `DELETE FROM scan_history WHERE id NOT IN (SELECT id FROM scan_history ORDER BY scan_timestamp DESC LIMIT 5000)` — this reads all rows, sorts them, and deletes the rest. With 5000+ rows, this is a full table scan + sort.
**Cost**: **5–20 ms** per scan history insert.
**Fix**: Use a simpler bounded approach:
```sql
DELETE FROM scan_history WHERE id IN (
  SELECT id FROM scan_history ORDER BY scan_timestamp ASC LIMIT (
    SELECT MAX(0, COUNT(*) - 5000) FROM scan_history
  )
);
```
Or better: use a trigger or periodic maintenance job.

### 12. No response compression on large API endpoints

**File**: All route files — every response uses `NextResponse.json()` without compression.
**Problem**: `/api/saved-markets` returns 574 KB uncompressed. `/api/logs` can return large payloads. `/api/scan` outcomes array can be 50–200 KB.
**Cost**: **~200–500 ms** additional transfer time on slow connections.
**Fix**: Enable Next.js response compression (built-in) or add `Content-Encoding: gzip` manually:
```ts
return NextResponse.json(data, {
  headers: { 'Content-Encoding': 'gzip' } // Next.js handles this automatically
});
```

### 13. `refresh-job.ts` runs sequentially with per-market state writes

**File**: `src/app/api/saved-markets/refresh/route.ts` / `src/lib/refresh-job.ts` lines 63–99
**Problem**: `runRefreshJob` iterates markets one at a time (line 63: `for (let i = 0; i < markets.length; i++)`). Each iteration calls `refreshSingleMarket` (full upstream fetch + matching) then writes state to disk. For 300 markets at 2s each, that's **10 minutes** of sequential work.
**Cost**: UI blocks for the full duration. No progress visibility until the end.
**Fix**: Parallelize with concurrency limit (like the poller's `mapWithConcurrency`):
```ts
// Use the same mapWithConcurrency from poll.mjs:
await mapWithConcurrency(markets, 5, async (market) => { ... });
```
**Expected**: 5× faster (10 min → 2 min).

---

## P3 — Low / Architectural

### 14. Redis is NOT justified — in-process cache is sufficient

**Analysis**: This is a single-node app (PM2 `next start` on port 3000). The poller (`scripts/poll.mjs`) is a separate process that calls the Next.js API via HTTP. Cross-process sharing is needed for the poller to benefit from the Next.js in-process cache.

**Verdict**: Redis adds ops burden (process management, memory limits, persistence) for marginal gain. The poller already has its own state (breaker state file, adaptive config). The right approach:
- **In-process TTL cache** in Next.js for gamma/Kalshi (findings #4, #8) — the poller hits the API, which serves from cache.
- **Poller-side cache**: The poller could cache upstream results in its own process for 5–10s.
- **Redis only if**: You add a second Next.js instance, or need cross-process pub/sub for live updates.

### 15. Multiple DB client instances (4 files)

**File**: `persistence.ts`, `settings.ts`, `arb-lifecycle.ts`, `watch-targets.ts` — each has its own `getClient()` singleton.
**Problem**: 4 separate libSQL connections to the same file. libSQL handles this fine (it's a single process), but each has its own `busy_timeout` and its own `initDb()` call.
**Cost**: Minimal (libSQL is single-writer anyway). But it's a maintenance burden — WAL mode must be set in 4 places.
**Fix**: Create a shared `src/lib/db-shared.ts` with a single client and export it everywhere.

### 16. PM gamma rate limit is generous but unused

**File**: `src/lib/rate-limiter.ts` line 278
**Problem**: Gamma has 300 tokens with 33ms refill (30 req/s sustained). In practice, a scan makes 1–2 gamma calls. The queue size of 100 means 100 requests can pile up, causing tail latency spikes.
**Cost**: Under burst, requests wait in queue for **seconds** before being served.
**Fix**: Reduce `maxQueueSize` to 20. The rate limiter should reject (not queue) when saturated.

---

## Summary of Priority Fixes (by effort vs impact)

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| P0-1 | SQLite WAL + synchronous | 5 min | 2–5× read throughput |
| P0-2 | SQL-filtered logs query | 15 min | 150ms → 5ms |
| P0-3 | SQL-filtered dashboard stats | 20 min | 300ms → 50ms |
| P0-4 | Kalshi/PM gamma TTL cache | 30 min | 1–2s saved per scan |
| P1-5 | Skip JSON mirror on scan updates | 5 min | 50–150ms saved per write |
| P1-6 | Implement `fields=basic` | 10 min | 574KB → 20KB response |
| P1-7 | Targeted market lookup by URL | 10 min | 50–100ms saved per scan |
| P1-8 | PM gamma dedup within scan | 15 min | 2–5s saved per scan |
| P2-9 | Increase CLOB cache TTL | 2 min | Saves cross-scan duplicates |
| P2-13 | Parallelize refresh job | 30 min | 10 min → 2 min |