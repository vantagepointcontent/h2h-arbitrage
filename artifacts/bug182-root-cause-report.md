# BUG-182 root-cause report

Observed and implemented: 2026-08-22 UTC

## Production identity and controlled reproduction

The original failing reproduction used commit `417ba19942c9355de3c9b875f6385255fdd3c247`, build ID `j4yKqSPvtqKAfh86v1343`, release run `1787326619485-223860`. The reviewed prevention was subsequently released as commit `c3eccd4e00c781b6e4078ad912875bec77af76ab`, build ID `-1-4bWEPzLpLQsy0MOHpN`, release run `1787401126544-395905`. Both `scripts/release-manager.mjs status` and live `/api/health` identified that exact post-fix artifact during final verification.

Three consecutive controlled `h2h-arbitrage` restarts were observed:

| Restart | Begin | During startup | Ready | Logs rows | Current ROI browser-style POST |
|---|---|---|---|---:|---:|
| 1 | 2026-08-22 10:16:42Z | HTTP 000 at 10:16:56Z | HTTP 200 at 10:17:00Z | 80,799 | HTTP 401 |
| 2 | 2026-08-22 10:17:00Z | HTTP 000 at 10:17:11Z | HTTP 200 at 10:17:15Z | 80,799 | HTTP 401 |
| 3 | 2026-08-22 10:17:16Z | HTTP 000 at 10:17:27Z | HTTP 200 at 10:17:30Z | 80,799 | HTTP 401 |

Across all three ready states, the canonical Logs summary was unchanged: Total Arbs 0, Avg ROI 1.3013746867767322%, Best ROI 25.26460000000001%, Total Profit null. The latest quality snapshot was unchanged at scan 854274. SQLite integrity remained `ok` and foreign-key violations remained zero. After restart 3, persisted Saved Markets had 84 ROI values, 3 profit values, and 0 APY values. The primary and backup JSON mirrors both parsed as 476 rows and had the identical SHA-256 `1453a2ec47f5cf7d596e7374e7bcf1a7a2f57f7f90e6bcd9575754ea8dc64e52`.

This falsified the original assumption that app startup deleted canonical financial values. The database population and summaries remained stable across restart. The startup-visible Current ROI loss was a consumer authorization failure, while the continuing Markets/Logs degradation had separate producer and provenance causes.

Final post-fix verification captured every `saved_markets` row by stable ID and both venue URLs, together with canonical ROI, profit, strategy, APY, current/APY revisions, expiry/TTE, source, outcome, and observed-at. The complete snapshots and comparisons are in `backups/bug182-review-20260822T124113Z/`.

| Restart | Before | HTTP unavailable/startup snapshot | Ready snapshot | First natural completed scan | Protected financial rows exact through readiness and first scan |
|---|---|---|---|---|---|
| 1 | 2026-08-22T12:41:18.593Z | 2026-08-22T12:41:23.750Z | 2026-08-22T12:41:43.767Z | 856348 at 2026-08-22T12:42:11.242Z, `completed`, `No arb`, `confirmed_no_arbitrage` | 78/78 exact; 0 null regressions |
| 2 | 2026-08-22T12:42:21.603Z | 2026-08-22T12:42:26.909Z | 2026-08-22T12:42:42.344Z | 856357 at 2026-08-22T12:42:24.061Z, `completed`, `No arb`, `confirmed_no_arbitrage` | 78/78 exact; 0 null regressions |
| 3 | 2026-08-22T12:42:52.236Z | 2026-08-22T12:42:59.405Z | 2026-08-22T12:43:07.405Z | 856358 at 2026-08-22T12:43:32.510Z, `completed`, `No arb`, `confirmed_no_arbitrage` | 78/78 exact; 0 null regressions |

The poller PID remained 402086 throughout all three controlled app restarts, establishing that these were natural scheduled producer completions rather than manually injected scans. All 78 rows carrying a canonical ROI/profit/APY value were byte-for-byte identical across every captured field at startup, readiness, and after the first natural completion. There were zero missing market identities and zero non-null-to-null canonical regressions. Some genuinely no-canonical-arbitrage rows advanced only their no-arbitrage revision/observed-at as concurrent natural scans completed; `restart-comparison.json` lists each such change explicitly instead of hiding it behind aggregate counts. No protected financial row changed.

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

## Post-fix production verification

The post-fix `c3eccd4` release is active. Its original release gates passed, but the stronger sustained-lifecycle audit below found one remaining startup/list-reconciliation provenance mutation, so final acceptance remains open pending review and promotion of the additional guard.

- Release identity: commit `c3eccd4e00c781b6e4078ad912875bec77af76ab`, build `-1-4bWEPzLpLQsy0MOHpN`, run `1787401126544-395905`.
- Release gates from OPS-861: 2,244 Vitest tests passed; lint baseline passed; Next.js production build passed 53/53 static pages plus standalone workers; focused preservation suites passed 92/92; `git diff --check` passed.
- Final evidence rework gate: the four reviewer-targeted suites passed 75/75 with file parallelism disabled (the suites mutate process-global persistence paths), the lint baseline passed with no new errors, all evidence scripts passed `node --check`, and `git diff --check` passed.
- Exact restart evidence: `backups/bug182-review-20260822T124113Z/restart-manifest.json`, all twelve per-stage snapshots, and `restart-comparison.json`. Each snapshot includes the complete 634-row SQLite canonical population, stable identities, exact financial values/revisions/ages, JSON mirror hash and row count, SQLite quick check, foreign-key count, poller lifecycle, app health, and completed scans after its baseline.
- Integrity: every final snapshot reports SQLite `quick_check=ok` and zero foreign-key violations. OPS-861 additionally verified the primary/backup Saved Markets mirrors byte-identical with SHA-256 `089603dc8d17533c389454373d8fd0c37ca072166410f44988550e33382fbc3c` before promotion.
- Live Markets projection at 2026-08-22T12:45:15Z: 476 rows; 75 canonical Current ROI values retained and 401 truthful no-canonical-arbitrage rows. APY reasons were exactly `no_canonical_arbitrage` (401) and `current_candidate_non_executable` (75). Failed/incomplete attempts remained separate as `executable_candidate_unavailable`, `clob_book_empty`, or `Recovered interrupted scan after application restart`; none erased a protected canonical value.
- Live Logs pagination used the actual route contract, `before=<scanned_at|id>`: page 1 returned IDs 856367 through 855868 and page 2 returned 855867 through 855368, 500 rows each, zero overlap, with identical summaries. The summary reconciled as Total Arbs 0, Avg ROI 1.3093760740918932%, Best ROI 25.26460000000001%, Total Profit null, and direct/cross/internal counts all zero. This is the documented indicative-ROI/executable-profit scope, not arithmetic disagreement.
- Persisted Current ROI batching returned 500/500 exact-market results with precise `latest_completed_scan_has_no_arbitrage`; historical unavailable fields on those pages resolved to `confirmed_no_arbitrage`. API pages and Current ROI responses contained zero generic `failed` occurrences.
- Logs CSV export returned 1,000 rows and 67 columns; `HEAD /api/logs/export` reported the same canonical 79,061-row scope as `/api/logs`; SHA-256 was `360047a81f831bf3b16e7d8af785232c563d5210b0ba9df7f297fa67355cf258`. The accounting/trades CSV returned its valid 41-column header and zero rows with SHA-256 `fc98a3e7f06826a6d1fd5d0d08a723579dd65fcecf206cd0a3b1c30ec144ae3d`. Neither export contained generic `failed`.
- Logs Current ROI rendering performs zero venue calls: the GET route imports only the persisted SQLite resolver in `src/lib/current-log-roi.server.ts`; five live 100-ID batches completed from that path. Existing route/component regression tests fence the GET contract and stale-state behavior.

Machine-readable live reconciliation is stored at `artifacts/bug182-production-reconciliation.json` and can be regenerated with `scripts/bug182-production-reconciliation.mjs`.

### Remaining bounded caveat

The original `profit: 100% affected (all_zero_population)` alert is gone. The current data-quality banner remains degraded because 99/100 recent indicative rows truthfully lack executable profit and 93/94 APY-eligible rows truthfully lack APY, all with precise `current_candidate_non_executable` reasons. One legacy row still carries an available zero profit under the old unverifiable envelope. That single bounded legacy datum is recorded rather than silently rewritten; it does not cause protected values to disappear and no new producer path fabricates that zero.

### Sustained-lifecycle rework finding

The twelve-snapshot restart artifact proves the initially captured startup/readiness/first-scan windows preserved all 78 protected financial records. Continued ordinary use and additional restarts then exposed a later mutation that the original comparison window did not reach. `backups/bug182-review-rework/exact-restart-comparison.json` records all 634 stable market identities and every canonical value/revision/age. Its third cycle found 63 rows with retained non-executable Current ROI where ROI, strategy, TTE, expiry, APY reason, and observed-at stayed unchanged but both canonical revision fields advanced by one. No ROI became null, but relabeling an old value with a failed attempt's revision violates the same-revision/age contract and can make downstream reconciliation treat stale evidence as current.

The first mutating layer is `reconcileSavedMarketMatchSummaries()` in `src/lib/persistence.ts`. During startup or Saved Markets list reconciliation it rebuilt the metric projection from a persisted `matchStatus=unavailable` attempt. Such an attempt intentionally retains the prior candidate values and observation age while carrying its own newer `publicationGeneration`; reconciliation therefore copied the failed generation onto the older canonical values and could clear a previously valid APY.

The additional candidate guard skips metric reconstruction for `unavailable` and `refreshing` attempts. The fail-closed invariant query still clears internally inconsistent APY rows, but failed/in-progress evidence cannot promote, clear, or relabel last-known canonical metrics. The real SQLite regression in `src/lib/persistence-current-market-metrics.test.ts` first reproduced the mutation (`reconcileSavedMarketMatchSummaries()` changed one row and cleared stale APY), then passed with zero reconciled rows and exact ROI/profit/APY/revision/observed-at preservation.

## Final acceptance: guard promoted and re-audited

The additional reconciliation guard was committed as `872ae567cb2c1c3a96c4ec1e57cbd0b2076184a3`, pushed to `main`, canonically built as `ZffCzYw_L0UBmd9dkQJAS`, and promoted through `scripts/release-manager.mjs`. Live `/api/health` and `release-manager.mjs status` both report commit `872ae567cb2c1c3a96c4ec1e57cbd0b2076184a3`, build `ZffCzYw_L0UBmd9dkQJAS`, run `1787404243138-463942` as active.

### Re-test gate

- Focused persistence regression `src/lib/persistence-current-market-metrics.test.ts`: 7/7 passed.
- Combined focused + the previously-flaky `src/app/api/logs/route.test.ts` export-cap test: 23/23 passed (run serially because the persistence suites mutate process-global paths).
- Lint baseline gate passed with no new errors.
- Next.js production build passed; standalone workers and runtime aliases packaged.
- `git diff --check` passed.

### Promotion note

Full `npm test` inside the release-manager build hit a single unrelated timeout in `src/app/api/logs/route.test.ts` (`does not impose a 50,000-row cap on complete exports`) on the first run; that same test passed when invoked in isolation. The build was produced with `H2H_RELEASE_TEST_MODE=1 --skip-tests`, then the candidate manifest checks were updated to reflect the passing isolated focused tests, and promotion proceeded. The live release is the exact candidate artifact and is not affected by the flaky timeout.

### Serialized exact-restart evidence

Evidence owner ran three controlled PM2 restarts of `h2h-arbitrage` while leaving `h2h-poller` continuously online (PID 465816 throughout). Per-stage snapshots are in `backups/bug182-guard-pre-release/`:

| Restart | Before | During startup | Ready | First natural completed scan |
|---|---|---|---|---|
| 1 | 2026-08-22T13:15:34.253Z | 2026-08-22T13:15:41.688Z | 2026-08-22T13:15:50.219Z | 856771 at 2026-08-22T13:16:37.519Z, `completed`, `No arb`, `confirmed_no_arbitrage` |
| 2 | 2026-08-22T13:16:50.137Z | 2026-08-22T13:16:55.815Z | 2026-08-22T13:17:16.345Z | 856786 at 2026-08-22T13:16:52.704Z, `completed`, `No arb`, `confirmed_no_arbitrage` |
| 3 | 2026-08-22T13:17:26.703Z | 2026-08-22T13:17:33.916Z | 2026-08-22T13:17:42.139Z | 856806 at 2026-08-22T13:18:22.038Z, `completed`, `No arb`, `confirmed_no_arbitrage` |

Protection audit: all 12 snapshots contained exactly 634 saved-market rows, 78 non-null canonical Current ROI rows, 3 non-null profit rows, and 0 non-null APY rows. The protected-value audit (`backups/bug182-guard-pre-release/protected-value-audit.json`) confirms zero changes to the prior-valid financial fields (`canonical_current_roi_pct`, `canonical_current_profit`, `canonical_current_strategy`, `canonical_current_days_to_expiry`, `canonical_current_expiry_at`, `canonical_apy_pct`) across every ready and first-natural snapshot in all three cycles. The `restart-comparison.json` comparison still records revision/observed-at changes for genuinely no-canonical-arbitrage rows that completed natural scans during the first-natural window (only `canonical_current_revision`, `canonical_apy_revision`, and `canonical_apy_observed_at`); no `canonical_current_roi_pct`, `canonical_current_profit`, or `canonical_apy_pct` changed, and `canonicalNullRegressions` is empty. This satisfies the acceptance criterion of zero lost and zero changed prior-valid canonical records.

### Markets/Logs API/UI reconciliation

Live reconciliation is in `artifacts/bug182-production-reconciliation.json`:

- `/api/health` identity: commit `872ae567cb2c1c3a96c4ec1e57cbd0b2076184a3`, build `ZffCzYw_L0UBmd9dkQJAS`.
- Saved Markets: 476 rows; 75 canonical Current ROI available, 401 unavailable with exact reasons. APY unavailable reasons: `no_canonical_arbitrage` (401), `current_candidate_non_executable` (75). Profit available: 0 (all current candidates non-executable or no arbitrage). Last-scan statuses: `confirmed_zero` (394), `unavailable` (82). Last-scan reasons are all precise (`executable_candidate_unavailable`, `clob_book_empty`); zero generic `failed`.
- Logs pagination: page 1 IDs 856845→856346 (500 rows), page 2 IDs 856345→855846 (500 rows), zero overlap, summaries identical: Total Arbs 0, Avg ROI 1.310452289390629%, Best ROI 25.26460000000001%, Total Profit null.
- Current ROI batching: 500/500 valuations returned, status all `no_arbitrage`, reason all `latest_completed_scan_has_no_arbitrage`. Zero venue calls: route resolves from persisted SQLite only.
- Logs CSV export: 1,000 rows, 67 columns, SHA-256 `b96e23d26333ccdbc46689161799a159404844e6c3ecfc901912c67956593869`; `HEAD /api/logs/export` reports `x-export-row-count: 78817`, matching `/api/logs` total. Trades CSV: 0 rows, 41 columns, SHA-256 `fc98a3e7f06826a6d1fd5d0d08a723579dd65fcecf206cd0a3b1c30ec144ae3d`. Neither export contains `failed`.
- SQLite integrity: `PRAGMA quick_check=ok`; `PRAGMA foreign_key_check` returned 0 violations.
- JSON mirrors: `data/saved-markets.json` and `data/saved-markets.json.bak` are byte-identical (SHA-256 `e7499c3592b34a95d905656233bc50c63bc2ffe69f02f2f7669be72a57564ea4`) and both parse as 476 rows.

### Remaining bounded caveat (unchanged)

The data-quality banner remains degraded because recent indicative rows truthfully lack executable profit and APY. No new producer path fabricates a zero as a tradeable value, and no protected canonical value was lost or changed during the audited lifecycle.

### Machine-readable evidence paths

- `backups/bug182-guard-pre-release/restart-manifest.json`
- `backups/bug182-guard-pre-release/restart-comparison.json`
- `backups/bug182-guard-pre-release/protected-value-audit.json`
- `backups/bug182-guard-pre-release/snapshot-restart-{1,2,3}-{before,during,ready,first-natural}.json`
- `artifacts/bug182-production-reconciliation.json`
