# BUG-182 root-cause report

Observed and implemented: 2026-08-22 UTC

## Production identity and controlled reproduction

The active production artifact throughout the reproduction was commit `417ba19942c9355de3c9b875f6385255fdd3c247`, build ID `j4yKqSPvtqKAfh86v1343`, release run `1787326619485-223860`.

Three consecutive controlled `h2h-arbitrage` restarts were observed:

| Restart | Begin | During startup | Ready | Logs rows | Current ROI browser-style POST |
|---|---|---|---|---:|---:|
| 1 | 2026-08-22 10:16:42Z | HTTP 000 at 10:16:56Z | HTTP 200 at 10:17:00Z | 80,799 | HTTP 401 |
| 2 | 2026-08-22 10:17:00Z | HTTP 000 at 10:17:11Z | HTTP 200 at 10:17:15Z | 80,799 | HTTP 401 |
| 3 | 2026-08-22 10:17:16Z | HTTP 000 at 10:17:27Z | HTTP 200 at 10:17:30Z | 80,799 | HTTP 401 |

Across all three ready states, the canonical Logs summary was unchanged: Total Arbs 0, Avg ROI 1.3013746867767322%, Best ROI 25.26460000000001%, Total Profit null. The latest quality snapshot was unchanged at scan 854274. SQLite integrity remained `ok` and foreign-key violations remained zero. After restart 3, persisted Saved Markets had 84 ROI values, 3 profit values, and 0 APY values. The primary and backup JSON mirrors both parsed as 476 rows and had the identical SHA-256 `1453a2ec47f5cf7d596e7374e7bcf1a7a2f57f7f90e6bcd9575754ea8dc64e52`.

This falsifies the original assumption that app startup deletes canonical financial values. The database population and summaries remain stable across restart. The startup-visible Current ROI loss is a consumer authorization failure, while the continuing Markets/Logs degradation has separate producer and provenance causes.

## First divergent layers

### 1. Logs Current ROI: read-only persistence lookup was sent as an authenticated mutation

`LogsPanel` used `POST /api/logs/current-roi` for a read-only batch. Global middleware protects every non-GET API request. Production returned HTTP 401 for that browser request after every restart and during continuous use. `LogsPanel` discarded the response details and projected every visible row as generic `Unavailable / failed`.

The persisted resolver itself was healthy: the working candidate's unauthenticated GET returned 100/100 persisted valuations (15 available, 85 `no_arbitrage`) with exact reason code `latest_completed_scan_has_no_arbitrage`. The module has no venue resolver, order-book, or scanner dependency, so rendering performs zero venue calls.

### 2. Refresh failure erased a previously displayed Current ROI in client state

Every Logs refresh cleared the complete `currentRoiById` map before the replacement lookup completed. Any transient HTTP/database failure therefore converted a previously valid persisted value into `Unavailable / failed`. The catch path also replaced every requested row with a generic status and no machine-readable reason.

### 3. Sparse one-sided scans were classified and persisted as completed zero-arb scans

The full scanner swallowed Kalshi fallback failures into an empty array. It then computed `matchedCount = 0`, published `matchStatus = confirmed_zero`, persisted a `No arb` saved-market result, and added a completed Logs row. A missing venue is not authoritative evidence that no arbitrage exists. This lifecycle transition allowed credential/feed degradation to replace a valid canonical Saved Markets projection and continually append misleading zero rows during normal polling.

The first mutating code was `src/app/api/scan/scan-execution.ts`: one-sided empty Kalshi or Polymarket populations were permitted to cross the completed-publication boundary.

### 4. Non-executable indicative candidates published zero profit as an available financial value

The scanner intentionally retains indicative ROI for non-executable candidates, but their `expectedProfit = 0` and `totalStake = 0` mean no tradeable profit/stake was established. Revision-3 provenance marked every finite scalar—including those compatibility zeros—available. The quality evaluator consequently saw 100 available zero profits and emitted `profit: 100% affected (all_zero_population)` with no per-row missing reason.

The first divergent code was `resolveHistoricalScanFinancials`: it did not consume the persisted selected candidate's `executionStatus` and `executionBlocker` when resolving profit, stake, and APY.

### 5. Summary inconsistency was semantic, not arithmetic corruption

Total Arbs is executable-only. Avg/Best ROI intentionally include persisted indicative selected-candidate ROI. Total Profit is executable-only and null when no executable row has authoritative profit. Thus `Total Arbs: 0`, positive Avg/Best ROI, and null Total Profit can be truthful only when the UI and API explain indicative versus executable scope. The OpenAPI Total Profit description incorrectly called it indicative and has been corrected.

### 6. Review rework: partial CLOB failures could still cross the canonical publication boundary

The first implementation fenced only an empty venue catalog. It still caught a failed CLOB metadata request and substituted an empty map, returned raw Gamma markets when selected CLOB metadata or per-token books were missing, and allowed a wholly non-executable indicative candidate set to publish as `matchStatus=matched`. `updateSavedMarketScanResult` treated that publication as a successful full scan and atomically replaced the prior canonical ROI/profit/APY revision. This was the remaining continuous-use mutating path identified in review round 1.

The corrected scanner now fails closed before publication for five distinct states: `clob_metadata_unavailable`, `clob_metadata_incomplete`, `clob_book_unavailable`, `clob_book_empty`, and `executable_candidate_unavailable`. The persistence boundary independently converts any matched positive candidate set lacking executable or legacy-complete evidence into an unavailable attempt, preserving the previous `allArbs`, observation time, canonical ROI/profit/APY values, and canonical revision. This defense prevents alternate or future producers from bypassing the route-level guard.

## Implemented prevention

- Added `GET /api/logs/current-roi?ids=...` for the read-only browser batch; retained POST for service compatibility. GET is bounded to 100 positive IDs, persisted-only, no-cache, and documented in OpenAPI.
- `LogsPanel` now uses GET, preserves last-known Current ROI through a failed replacement lookup, fences stale generations, and gives first-time failures the precise reason code `current_roi_lookup_failed`.
- Full scans now fail closed with HTTP 503 and `kalshi_market_data_unavailable` or `polymarket_market_data_unavailable` when either venue yields no usable market population. The reserved Saved Markets publication becomes `unavailable`; no completed saved-market result, BotTrader scan, scan-history row, or Logs financial row is published.
- Selected CLOB metadata and books must be complete. Metadata transport failure, omitted selected conditions, per-book failure, empty executable books, and wholly non-executable positive candidate sets each publish a precise unavailable-attempt reason and retain the prior completed canonical revision.
- `updateSavedMarketScanResult` provides a second fail-closed boundary: a producer cannot label an all-non-executable positive candidate set `matched` and replace a valid canonical ROI/profit/APY revision.
- Historical field resolution now consumes persisted candidate execution status. A `non_executable` candidate may retain authoritative indicative ROI, but profit, stake, and APY are unavailable with reason code `current_candidate_non_executable` plus the persisted execution blocker. Zero is no longer fabricated as a tradeable financial value.
- Existing 500-row bottom-reach loading, exact-market URL-pair Current ROI identity, stale-generation fencing, CSV streaming, and POST compatibility are unchanged.

## Regression and build evidence

- Review-rework focused suite: 6 files, 90 tests passed, including five real `executeFullScan` → SQLite persistence probes seeded with a prior executable ROI/profit/APY revision.
- Full Vitest after review rework: 273 files, 2,242 tests passed.
- Lint baseline gate passed with no new errors.
- Working-tree Next.js 16.2.6 production build passed at 2026-08-22T10:48:23Z: 53/53 static pages, `/api/logs/current-roi` emitted as a dynamic route, and all standalone workers bundled.
- Candidate runtime on port 3012: GET returned 100 persisted valuations (15 available, 85 exact no-arbitrage reasons); unauthenticated legacy POST remained protected with HTTP 401.
- Data integrity: SQLite `integrity_check=ok`, zero foreign-key violations, both 476-row JSON mirrors valid and byte-identical.
- `git diff --check` passed.
- Post-rework data integrity: SQLite `integrity_check=ok`, zero foreign-key violations; both JSON mirrors parse as 476 rows and are byte-identical with SHA-256 `ec677d6f8cf62ca441e256577b233cfbfbc503ac58f1dece1c8bd6d072a575e4`.

## Production release gate

The active release remains commit `417ba199...`; this working-tree task did not create or promote a commit. Therefore post-fix sustained production polling, two distinct 500-row browser bottom reaches, and three post-fix production restarts must be completed by the reviewed release lane. The pre-fix three-restart evidence above is complete and establishes that canonical rows were not deleted on startup; the visible recurrence was the protected POST plus ongoing sparse/non-executable publications.
