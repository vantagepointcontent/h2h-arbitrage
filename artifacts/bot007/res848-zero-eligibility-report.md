# RES-848 — Persisted BotTrader zero-eligibility classification

Generated: 2026-08-19
Scope: read-only persisted evidence; no production state, policy, sizing, thresholds, credentials, or execution changed.

## Disposition

No genuine candidate in the surviving current persisted evidence satisfies every unchanged BotTrader acceptance gate. The exact external-data prerequisite is:

> A fresh, unclaimed direct-arbitrage candidate whose exact selected Kalshi and Polymarket contracts exist in the server-owned canonical proposition registry, whose selected legs both have executable depth for the authoritative venue-minimum quantity, whose authoritative non-negative fees are present for both legs, and whose resulting net ROI meets the active 2% threshold at scan time and revalidation.

The visible positive ROI is necessary but not sufficient. The recovered candidate evidence contains zero all-gates-pass candidates and therefore no dry-run placement candidate.

## Evidence provenance and incident limitation

The original OPS-847 artifacts and the production DB snapshot through scan 847281 were deleted during the documented workspace-cleanup incident. They were not regenerated or synthesized. This report uses only surviving real evidence:

1. Hermes terminal-cache copy of the original read-only persisted-candidate query: `/home/scott/.hermes/cache/terminal-output/out-1787150530-3234082-5550.log`.
2. Durable BOT-007 Kanban comment 1352, recorded before deletion.
3. Current acceptance code at `src/lib/bot-scan-consumer.ts` and `src/lib/bot-trader.ts`.
4. Recovered machine-readable gate vectors: `artifacts/bot007/res848-candidate-gates.json`.
5. Reproducer: `artifacts/bot007/build-res848-evidence.mjs`.

The recovered query was generated at 2026-08-19T14:42:10.381Z over decisions since scan 846000. Its aggregate population is 432 candidates: 432 finite authoritative fee pairs, 431 pairs explicitly naming five-share fee calculations, 0 eligible/accepted, and terminal reason `scan_criteria_rejected` for all 432. The cache retained complete row-level operands for the latest 50 candidates. Every one of those 50 has a source scan ID, candidate index, market ID, outcome, strategy, terminal reason, exact input envelope, and gate vector in the JSON artifact.

Earlier BOT-007 evidence across every completed positive scan since the last paper position reported 18,573 positive scans, 14,671 candidate decisions, cursor lag 0, 12,710 finite authoritative fee pairs, and 0 eligible/accepted. Its terminal split was:

- 12,331 `scan_criteria_rejected`
- 1,468 `execution_unavailable` (historical/stale terminal telemetry)
- 337 `fees_unavailable` (historical pre-fix rows)
- 214 `opportunity_already_claimed`
- 132 `current_criteria_rejected`
- 28 `execution_rejected`
- 4 `market_identity_changed`

These terminal counts sum to 14,514; the surviving comment did not retain the remaining 157 terminal classifications. I will not invent the missing split. The authoritative total and zero eligible/accepted result remain preserved.

## Terminal versus multi-gate views

Terminal reasons are mutually exclusive persisted outcomes. The recovered 432-candidate population has exactly 432 terminal `scan_criteria_rejected` decisions, so terminal totals reconcile without double counting.

The additional-gate view is intentionally multi-counted. For the 50 candidates with fully recovered operands:

- 50/50 fail canonical proposition identity.
- 34/50 also fail matched five-share executable depth.
- 41/50 also fail the active 2% ROI threshold.
- 0/50 fail fee presence or finite/non-negative explicit five-share fee handling.
- 0/50 fail selected Polymarket minimum quantity recording (all record minimum 5).
- 0/50 fail positive fee-inclusive profitability; all have positive persisted net ROI, though most remain below the active threshold.
- 0/50 pass all recorded scan-time gates.

Revalidation, reservation/duplicate, risk/daily-limit, and execution-validation gates are marked `not_reached` for these 50 because scan-time eligibility failed. This is not treated as a pass.

## Required gate coverage

- Authoritative fee presence: persisted under `details.inputs.fees`; fail closed when absent.
- Finite non-negative Kalshi/Polymarket fees: required by `validFees()` in `src/lib/bot-scan-consumer.ts`; the recovered detailed population passes.
- Selected venue minimum quantity: persisted under `details.inputs.venueConstraints`; recovered evidence records 5 shares.
- Matched executable depth: evaluated for the selected legs against requested 5 shares in the evidence-time contract; 34/50 recovered rows fail.
- Net profitability after both fees: persisted ROI is fee-inclusive; positive ROI alone does not override any other gate.
- Active ROI/APY: settings are ROI selection, minimum ROI 2%, APY inactive (`minApyPct=0`).
- Freshness: row update timestamps and audit capture time are preserved; stale scans terminate before candidate placement.
- Canonical proposition identity: exact selected contracts must exist in the server-owned registry; 50/50 recovered rows fail.
- Malformed/unsupported shape: recovered detailed rows parsed with exact IDs and supported strategy; malformed rows terminate before this population.
- Current revalidation: occurs only after initial eligibility; no recovered detailed candidate reached it.
- Duplicate/already claimed: reservation occurs only after revalidation; not reached in the recovered detailed population, but 214 historical decisions terminated there.
- Risk/daily limits: execution preflight follows scan and reservation eligibility; not reached here.
- Execution validation: no recovered candidate reached request construction or execution; no live trade was attempted.

## Visible high-positive reconciliation

All examples are real persisted decisions preserved in BOT-007 evidence:

- Scan 846765, NCAA / Notre Dame, 12.0344%: authoritative five-share fees and depth were present, but exact selected contracts were absent from the canonical proposition registry.
- Scan 847198 candidate 0, WI-06 Republican, 3.9476%: canonical identity failed and selected Kalshi NO depth was zero. Exact persisted inputs are retained in `res848-candidate-gates.json`: Kalshi NO ask 0.08, PM YES ask 0.87, five-share fees $0.03 and $0.02262, sharesK 0, sharesP 29.9.
- Scan 846979, MN-01 Democratic, 3.65%: canonical identity failed and selected Kalshi NO depth was zero.
- Scan 846957, TX-24 Republican, 2.7184%: canonical identity failed and selected Kalshi NO depth was zero.
- Scan 846139, NC-11 Republican, 2.5936%: canonical identity failed and selected Kalshi NO depth was zero.
- Stronger later recovered candidate: scan 847108 candidate 0, Troy Rohrbaugh succession market, 8.0944%. It failed canonical identity and selected Kalshi depth (`sharesK=0`; requested 5), despite positive fee-inclusive ROI.
- Latest recovered opportunity scan 847216 contained no candidate at or above 2%; its candidates also failed canonical identity, with selected-depth failures on the PM-YES/Kalshi-NO paths.

Thus the visible high-positive examples are indicative fee-inclusive opportunities, not executable BotTrader candidates.

## Safety confirmation

Authoritative five-share fee handling remains unchanged and fail closed. No missing fee was estimated. No identity or depth was synthesized. No threshold or sizing rule was weakened. BotTrader remains paper/manual-only; no live execution was attempted. The evidence-only artifact does not modify application code or production state.

## Reproduction

Run from the repository root:

`node artifacts/bot007/build-res848-evidence.mjs`

Optional explicit arguments:

`node artifacts/bot007/build-res848-evidence.mjs <surviving-terminal-cache-log> <output-json>`

The script strips the Hermes terminal footer, parses the original query JSON, derives deterministic terminal and additional-gate views, and writes the auditable candidate vectors. It performs no network calls and no database writes.
