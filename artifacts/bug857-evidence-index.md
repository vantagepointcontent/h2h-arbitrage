# BUG-857 production evidence index and limitations

Date: 2026-08-25 UTC

## Evidence labels

- `bug857-reconciliation-dry-run.json` is the authoritative earliest preserved pre-reconciliation snapshot. It was captured at `2026-08-25T20:47:21.754Z` and records 391 `confirmed_zero`, 3 `matched`, 124 `never_scanned`, 2 `refreshing`, 114 `unavailable`, and 23 rows carrying the retired `no_positive_candidate_persists_prior` reason.
- `bug857-production-reconciliation-apply.json` is an apply-time before/after record captured at `2026-08-25T21:20:44.883Z`. Its `before` section is observed pre-mutation data; its `after` section is observed post-mutation data.
- `bug857-after-census.json` is an observed post-reconciliation census captured at `2026-08-25T21:52:32.081Z` on deployment `557783e`. It is not pre-change evidence.
- `bug857-final-natural-cycles.json` and `bug857-final-health.json` are observed post-reconciliation runtime evidence on deployment `557783e`.
- `bug857-before-census.json` was captured at `2026-08-25T22:35:32.733Z`, after both the code deployment and reconciliation. Despite its filename, it is **not** a pre-change census and must not be cited as one.
- `bug857-profit-source-inspect.json` is a retrospective source inspection. It is observed database evidence about preserved rows, but its interpretation of historical causality is an inference.

## Missing evidence

No complete all-surface, field-by-field census was preserved before the first BUG-857 code deployment. The pre-change baseline must therefore be reconstructed from the timestamped reconciliation snapshots and historical scan records. Any reconstructed count is labeled inferred, not observed.

## Taxonomy correction

The original census classified every absent numeric value as unavailable and used `missing_field_projection` for the wrong historical keys (`profit` and `totalStake`). The corrected census:

- reads `profitUsd` and `stakeUsd` from `historical_financials.fields`;
- reports `confirmed_no_arbitrage` as `not_applicable`, not as a failure;
- reports `not_scanned`, `loading`, and `stale` independently from true unavailable states;
- computes availability over applicable rows while retaining full state counts;
- requires row totals, state totals, summaries, and export sample sizes to reconcile.

## Residual production cohort

After deployment `041c896`, Markets field health is healthy: every unavailable ROI/profit value has an explicit field reason, zero is not used as the unavailable sentinel, and the unavailable field cohort is below 5% of 474 scanned markets. Two retained positive-ROI rows have no attributable absolute profit and are explicitly marked `canonical_profit_not_persisted_for_retained_revision`; they are not coerced to `$0.00`.

The scanner remains operationally degraded, but the production snapshot bounds the affected cohorts: 6/474 markets (1.27%) have explicit unavailable scan state and 9/474 (1.90%) were overdue behind three open breakers at `2026-08-25T23:30:14Z`. Current reasons are upstream/market-specific: empty or incomplete Polymarket CLOB books, invalid/closed market URLs, and an authoritative Kalshi fee endpoint HTTP 429 observed behind the prior opaque HTTP 500 fingerprint. A later breaker-state read found four open market-specific breakers, all with zero consecutive failures and scheduled cooldowns. These failures retain prior canonical values or explicit unavailable state and do not contaminate healthy rows.
