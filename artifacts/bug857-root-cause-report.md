# BUG-857 Root-Cause and Production Reconciliation Report

Date: 2026-08-25 UTC
Deployment: `557783e41001ec616415c1087175a2699f815fa4` / build `nrpZD7QRAa2YjOX56YRiO`

## Incident summary

The apparent cross-surface metric collapse was not a Logs, Markets, CSV, detail-page, or BotTrader rendering defect. Two producer/persistence semantics had allowed a completed scan with no executable positive opportunity to be represented inconsistently:

1. The scan producer selected any executable candidate as its top-level result, including candidates with non-positive ROI, instead of selecting only a positive executable opportunity.
2. `updateSavedMarketScanResult()` treated a successful completed scan with no positive canonical candidate as `unavailable`, retained an older positive ROI/APY/strategy, and emitted `no_positive_candidate_persists_prior`.

That created one incoherent durable record: the newest completed observation said there was no positive opportunity, while the current snapshot retained the older positive financial classification and described the successful observation as unavailable. Every downstream surface then truthfully projected a different part of that conflicting durable state.

## First divergent layer

The first divergence was the scan producer and canonical saved-market persistence boundary:

- Scanner candidates with `executionStatus=non_executable` or a negative executable return were retained in `allArbs` for diagnostics.
- The scanner's top-level `bestRoiPct`, `bestProfit`, `strategy`, and `matchStatus` were previously based on a broader executable cohort than `positiveArbs`.
- Persistence selected only positive canonical candidates. When none existed, its retired `no_positive_candidate_persists_prior` branch preserved older canonical values and changed the latest completed scan to `unavailable`.
- Logs/history and BotTrader correctly used `positiveArbCount=0`, while Markets/current saved-market projections could still expose the prior positive ROI/APY. This was structural producer/persistence disagreement, not a label-only problem.

The corrected invariant is:

- Positive, executable candidate: publish canonical ROI/profit/APY and a matched positive classification.
- Completed scan with no positive executable candidate and no missing evidence: publish `confirmed_zero`, `strategy="No arb"`, no canonical financial metric, and `no_canonical_arbitrage` for not-applicable projections. Do not publish literal numeric zero as current ROI/APY.
- Positive candidate whose execution evidence is unavailable: fail closed as `unavailable`; preserve attributable prior canonical values and report the exact evidence failure.
- Non-executable diagnostic candidates remain in `allArbs` but cannot become the top-level financial opportunity.

## Why earlier partial fixes looked local

Recent APY, expiry-provenance, and Logs projection changes corrected how already-persisted fields were annualized or displayed. Those changes could make an individual field look better, but they did not alter the conflicting producer/persistence state. Separate UI or export fallbacks would have hidden the durable disagreement and left BotTrader and API consumers on different semantics.

The BUG-857 fix therefore changes the common producer/selector/persistence path and leaves Logs, Markets, saved-market APIs, exports, and BotTrader consuming the same canonical record.

## Code changes

- `src/app/api/scan/scan-execution.ts`
  - Selects top-level financial output only from `positiveArbs`.
  - Treats missing execution evidence as incomplete only when it affects a positive candidate.
  - Publishes non-executable and negative-only candidate sets as completed no-arbitrage observations while retaining raw diagnostics.
- `src/lib/persistence.ts`
  - Removes the successful-zero branch that retained stale canonical metrics.
  - Normalizes full-scan `matched` payloads without a positive executable candidate to `confirmed_zero`.
  - Clears ROI/profit/APY/outcome/time-to-expiry canonical fields atomically for confirmed no-arbitrage.
  - Advances ROI and APY revisions together to the completed publication generation.
  - Fences `confirmed_zero` before candidate selection, so retained diagnostic rows can never repopulate a no-arbitrage snapshot.
  - Continues to fail closed and preserve prior canonical values for truly unavailable positive execution evidence.
- `src/lib/canonical-saved-market-metrics.ts`
  - Ignores explicitly non-executable candidates when deriving saved-market financial metrics.
- `src/lib/pipeline-health.ts`
  - Existing production broad-collapse monitoring remains active; regression coverage now proves it detects a cohort-wide unavailable-state collapse while confirmed no-arbitrage remains non-degraded.
- `scripts/bug857-reconcile-collapsed-metrics.mjs`
  - Dry-run by default; apply mode requires and validates a safe SQLite backup.
  - Repairs only records carrying the exact retired `no_positive_candidate_persists_prior` provenance.
  - Fences each update on market ID, publication generation, and exact prior error.
  - Writes a durable per-record alert and verifies affected-row counts before commit.
  - Is idempotent. It intentionally does not rewrite `executable_candidate_unavailable`, CLOB-book, refreshing, never-scanned, or historical `scan_results` rows.

## Regression coverage

Focused regressions cover:

- non-executable positive candidate sets;
- negative executable candidate sets;
- completed zero-candidate full scans;
- unavailable execution evidence preserving prior canonical values;
- canonical revision equality across ROI/APY/publication generation;
- no-arbitrage values remaining null/not-applicable rather than literal zero;
- candidate-order independence;
- legacy/manual match-summary generation ordering;
- scanner persistence, Logs current-ROI selection, saved-market projection, and broad-collapse health semantics.

Verification gates on the committed isolated release candidate:

- Full Vitest suite: 276 files, 2,277 tests passed.
- Lint baseline: passed.
- Next.js production build: passed.
- SQLite integrity check: `ok`.
- Foreign-key violations: `0`.

## Production reconciliation

The production apply began with 474 saved markets and this cohort:

- `confirmed_zero`: 410
- `matched`: 3
- `never_scanned`: 124
- `refreshing`: 1
- `unavailable`: 96
- exact retired `no_positive_candidate_persists_prior` records eligible: 18

A concurrent natural scan repaired one additional record between dry-run and apply; the apply transaction reconciled the remaining 18 eligible records. It created and integrity-checked this backup before mutation:

- `backups/bug857-pre-reconcile-a976952.db`
- bytes: 4,413,231,104
- SHA-256: `ebb62fcb05fbc4a5d01a8af41a5c7b6926b6d1e352e3bbdeb96133fc25abed27`
- integrity: `ok`

Immediate post-apply state:

- `confirmed_zero`: 427
- `matched`: 3
- `never_scanned`: 124
- `refreshing`: 3
- `unavailable`: 77
- remaining retired-reason records: 0

A second dry-run found zero eligible records, proving idempotence. Subsequent natural scans continued converting old non-executable unavailable snapshots to confirmed no-arbitrage under the corrected producer contract. True CLOB/evidence failures remain unavailable with explicit reasons.

A controlled pass over the remaining 44 unavailable snapshots then admitted 27 completed scans, while 14 requests were rate-limited and three returned actionable evidence failures. The ordinary scheduler continued those retries. The first post-reconciliation census contained:

- `confirmed_zero`: 458 (96.62%)
- `unavailable`: 16 (3.38%)
- unavailable states without a reason: 0
- literal zero current ROI: 0

The remaining 16 are below the production 5% degradation threshold and all carry exact execution-evidence or CLOB-book reasons. They were not coerced to no-arbitrage or zero.

After the final selector-fence deployment and additional natural retries, the final census contained 461 `confirmed_zero`, 12 `unavailable`, and one in-flight `refreshing` snapshot. Markets health was healthy at 12/474 unavailable scan states (2.53%), with zero missing reasons and zero literal current-ROI zeros.

Four final natural-cycle samples on that exact release advanced completed jobs 71→132 and reduced unavailable scan states again from 12→10 (2.11%). All samples kept the deployment identity fixed, missing reasons and literal-zero ROI at zero, and BotTrader healthy with zero pending scans/cursor lag.

Historical `scan_results`, BotTrader decisions/positions, and raw diagnostic candidates were not rewritten. The migration scope was intentionally limited to saved-market current snapshots whose exact retired reason proves that the successful zero-candidate observation had already been persisted.

## Cross-surface verification

Post-deploy census verified:

- deployment identity matches commit/build above;
- 474 saved markets in both full/basic API modes;
- eight real last-known positive snapshots had both numeric ROI and APY (100% APY coverage for that cohort); confirmed no-arbitrage is null with `no_canonical_arbitrage`;
- no saved market publishes literal `canonicalCurrentRoiPct=0`;
- every unavailable scan state has a specific reason;
- recent Logs batches are completed no-arbitrage rows with not-applicable ROI/APY and BotTrader status `not_applicable_no_positive_arb`;
- BotTrader cursor remains caught up with zero pending scans and the latest completed scan;
- CSV retains the required reason columns and reconciles with API/history cohorts;
- DB/API history row counts and SQLite integrity reconcile.

Headless browser verification opened a real persisted Markets row (`MLS Cup Winner 2026`), confirmed numeric ROI/APY in both the list row and exact-market detail/sidebar, confirmed precise stale-last-known provenance, and observed no client-side venue fetches. On Logs, five recent completed no-arbitrage rows rendered `N/A` rather than `Unavailable`; two distinct bottom reaches each loaded exactly one additional 500-row batch (250→750→1,250), with no UI degradation banner.

Across six one-minute natural-cycle samples, completed jobs advanced 171→247, unavailable snapshots fell 60→44, literal zero ROI and missing reasons remained zero, and BotTrader stayed caught up. After controlled reconciliation, four more samples held unavailable state at 16 while completed jobs advanced 280→282; one transient BotTrader heartbeat degradation recovered in the following sample with pending scans and cursor lag both zero.

Evidence files:

- `artifacts/bug857-production-reconciliation-dry-run.json`
- `artifacts/bug857-production-reconciliation-apply.json`
- `artifacts/bug857-production-reconciliation-post.json`
- `artifacts/bug857-before-census.json`
- `artifacts/bug857-natural-cycle-observation.json`
- `artifacts/bug857-post-reconciliation-natural-cycles.json`
- `artifacts/bug857-final-natural-cycles.json`
- `artifacts/bug857-controlled-unavailable-rescan.json`
- `artifacts/bug857-after-census.json`
- `artifacts/bug857-browser-verification.json`
- `artifacts/bug857-production-markets.png`
- `artifacts/bug857-production-logs.png`

## Review-round field-contract correction

The first handoff exposed a second, narrower contract bug: canonical current ROI and absolute profit had been treated as if they shared one availability state. Eight then-positive retained snapshots had numeric ROI/APY but no persisted absolute profit, and neither persistence nor API/UI/health exposed a profit-specific reason. The census compounded the issue by treating confirmed no-arbitrage fields as unavailable and by reading the wrong historical profit/stake projection keys.

The final contract separates the fields:

- `canonicalCurrentRoiStatus` and `canonicalCurrentRoiUnavailableReason` describe ROI independently;
- `canonicalCurrentProfitStatus` and `canonicalCurrentProfitUnavailableReason` describe absolute profit independently;
- unavailable numeric values remain `null`; zero is never substituted;
- confirmed no-arbitrage is `not_applicable` with `confirmed_no_arbitrage`/`no_canonical_arbitrage` semantics;
- retained positive ROI without attributable historical absolute profit remains numeric ROI plus null profit and the precise reason `canonical_profit_not_persisted_for_retained_revision`.

Persistence, API normalization, list refresh, page mapping, Overview UI, OpenAPI, and Markets health now carry that same field-level contract. Legacy unavailable rows are reconciled to explicit `current_scan_unavailable` reasons. Per-field collapse monitoring alerts on unexplained values immediately and on unavailable cohorts exceeding 5% of all scanned markets, so a tiny explicit exceptional cohort does not falsely classify the entire pipeline as collapsed.

Final deployment `041c89668cbe0a8a5da822bfa2c42a95408d07e5` / build `rQRgHNW1-dKztoqAgFkUD` reports Markets healthy across all four natural-cycle samples. The final 474-row census has 468 confirmed-no-arbitrage rows (`not_applicable`), four current-scan-unavailable rows with reasons, and two retained-ROI rows whose profit is explicitly unavailable for the retained revision. There are zero unavailable zero sentinels and zero missing field reasons. The 1,500-row Logs/API/export census reconciles every row/state/reason count, pagination has no overlap, summaries exclude missing values, required CSV reason columns are present, SQLite integrity is `ok`, and foreign-key violations are zero.

The original `bug857-before-census.json` was captured after the first code/reconciliation changes and is not valid pre-change evidence. `artifacts/bug857-evidence-index.md` labels that limitation and identifies the timestamped reconciliation dry-run/apply records that form the preserved baseline. The authoritative final review-round artifacts are:

- `artifacts/bug857-evidence-index.md`
- `artifacts/bug857-final-field-census.json`
- `artifacts/bug857-final-field-natural-cycles.json`
- `artifacts/bug857-final-field-health.json`
