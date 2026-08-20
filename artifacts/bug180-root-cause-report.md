# BUG-180 root cause and release evidence

Observed: 2026-08-20 UTC

## First divergent layers

1. `src/app/api/scan/scan-execution.ts` intentionally narrowed `positiveArbs` to executable candidates, while preserving the selected indicative `bestNetArb` ROI/strategy. The persisted row therefore legitimately has `positive_arb_count = 0` beside non-zero event-time ROI when the candidate is non-executable.
2. OPS-859's Logs SQL summary incorrectly used executable `positive_arb_count` as the eligibility gate for historical ROI/profit. That excluded every recent indicative selected candidate and produced blanket zero summaries despite non-zero immutable scalar evidence.
3. Historical no-arb rows retained legacy physical zero sentinels. The resolver treated those as available financial values instead of `confirmed_no_arbitrage`/not-applicable.
4. BUG-179's saved-market selector required `executionStatus === executable`, positive profit, and positive stake before preserving any field. All 476 active markets currently have zero executable candidates because Kalshi credentials/feed are unavailable; 81 markets nevertheless retain authoritative positive indicative ROI in 138 explicitly non-executable persisted candidates. The all-or-nothing selector erased that ROI together with unavailable profit/APY.
5. Markets and Logs aggregate components divided by all rows and used `?? 0`, fabricating zero averages for unavailable populations.

## Implemented semantics

- Historical financial revision 3 persists field-level availability provenance, so compatibility zeros required by legacy `NOT NULL` columns cannot be mistaken for genuine zero calculations. Confirmed `No arb` rows remain nonnumeric not-applicable; genuine selected-candidate zero and negative calculations remain valid when backed by provenance.
- Scan persistence preserves selected candidate ROI/profit/stake independently of executable classification. Classification and executable opportunity count remain separate, and list/API/export resolvers all consume the same persisted provenance.
- Logs Avg/Best ROI use available selected-candidate event-time ROI under the same server-side filter scope. Total Profit is executable-only. No-arb/unavailable rows are excluded; Total Arbs/type buckets remain executable-only.
- Current Logs ROI returns the newest exact-pair persisted selected-candidate ROI even when its executable count is zero; confirmed `No arb` remains a separate state.
- Saved Markets preserves indicative ROI and strategy for explicit non-executable candidates while withholding executable profit/APY and exposing `current_candidate_non_executable`. Explicit unavailable candidates remain closed.
- Markets summary averages only available ROI and renders unavailable aggregates as dashes.
- Data-quality telemetry evaluates the bounded 100-row recent selected-candidate cohort (including `positive_arb_count = 0`), degrades immediately on a cold-start all-zero population, and triggers after >5% zero regression from a prior non-zero population.
- Reconciliation now executes at most two real evidence-bound attempts over those exact recent row IDs, records only attempts that ran, and CAS-fences scalar, raw payload, strategy, calculation envelope, and prior provenance.
- Recovery includes selected candidates with zero executable count, emits unrecoverable reason counts, and never invents values.
- OpenAPI documents nullable summaries and historical financial revision 3.
- Saved-market reconciliation bound now covers the complete active 476-market population (bounded at 1,000 rows).
- Legacy rows whose compatibility scalar is zero now use the same unambiguous one-candidate `raw_result` fallback in server-side ROI filters and summaries that the row/export resolver uses. Logs page queries carry the immutable raw payload only long enough to build `historical_financials`; the API removes it before responding.

## Production baseline (before deployment)

- `/api/logs` last-day scope: 22,442 rows; visible first 250 had 204 `No arb`, 0 visible non-zero ROI; summary Total Arbs/Avg ROI/Best ROI/Total Profit all zero.
- Immutable database census: 102,408 scans at final integrity check; prior census found 3,431 recent non-zero ROI rows despite zero recent executable-arb rows.
- `/api/saved-markets`: 476 active markets; 0 current ROI, 0 APY; 82 payloads exposed candidate ROI through the old API.
- Recovery census across exactly 476 active markets: 81 markets recover positive indicative ROI; 395 have no canonical selected candidate; 138 candidates are explicitly non-executable; 0 have executable profit/APY evidence. No profit/APY is invented.
- SQLite `PRAGMA integrity_check`: `ok`; foreign-key violations: 0.
- `saved-markets.json` and `.bak`: valid JSON, 476 rows each, identical SHA-256 at observation time.

## Verification

- Full Vitest before the final parity correction: 270 files, 2,203 tests passed.
- Final BUG-180 focused suite: 12 files, 145 tests passed, including legacy raw ROI parity across API rows, summaries, min-ROI filtering, and export.
- Lint baseline gate: passed; no new lint errors.
- Working-tree Next.js 16 production compile passed after the final parity correction into `.next-bug180-round4`.
- `git diff --check`: passed.
- Repository-wide `tsc --noEmit` remains red on pre-existing diagnostics outside this diff; no changed-file diagnostic was reported.
- Release-manager `npm run build` is commit-scoped and therefore built the current committed baseline, not this uncommitted Kanban workspace. Production promotion/reconciliation is intentionally gated on review and a reviewed commit; no production data was mutated during this implementation run.

## Round-4 canonical parity and release gate

- Regression: a legacy selected-candidate row with scalar ROI/profit/stake zero, no revision-3 provenance, and immutable `raw_result.allArbs[0].roiPct = 7` now resolves to ROI 7 in the paginated row, `minRoi` filter, Avg/Best summary, range maximum, and export stream.
- BUG-180 focused contract suite: 12 files, 145 tests passed.
- Full Vitest: 270 files, 2,204 tests passed. Lint passed with no new errors. Working-tree production compile passed with 53/53 pages. `git diff --check` passed.
- Read-only production observation before promotion: `/api/logs` reported 103,789 rows with Avg ROI 0.886769597804055 and Best ROI 23.86314, while its latest data-quality snapshot still had a zero-row denominator; `/api/saved-markets` returned 476 active rows and zero positive current ROI rows.
- Current database census: 103,765 scans at census start, 3,431 positive-ROI rows among 28,198 recent rows, 1,293 compatibility-zero rows with raw ROI evidence, and 13,888 zero-executable-count rows with raw ROI evidence. Integrity remained `ok` with zero foreign-key violations; both saved-market JSON files parsed with 476 rows and identical SHA-256.
- Production remains on release commit `e7da52421dd28a0f7c5cd671fa6eed2b8c7964fe`. The release manager only builds committed revisions in an isolated worktree. Because this task does not authorize creating a commit, no reviewed candidate can be built/promoted and no truthful post-deploy/restart distribution can yet be recorded.

## Artifacts

- `artifacts/bug180-census-before.json`
- `artifacts/bug180-saved-market-recovery-before.json`
- `artifacts/bug180-integrity-before.json`
- `artifacts/bug180-census.mjs`
- `artifacts/bug180-saved-market-recovery-census.ts`
- `artifacts/bug180-integrity.mjs`
