# CODE-002 Incremental Code Review

This review is intentionally one module and one verified change at a time. Runtime-generated data under `data/` is excluded from code commits.

## Findings

| ID | Severity | Area | Status | Evidence / disposition |
|---|---|---|---|---|
| CR-001 | High | `src/app/api/scan/route.ts` request validation | Fixed | `capital` was accepted directly from JSON. String, `NaN`, `Infinity`, zero, negative, and excessive values could reach fee/stake calculations. Added bounded finite-number validation (`$1`–`$1,000,000`) in `src/lib/scan-request.ts` and a 400 response before any upstream requests. |
| CR-002 | Medium | `src/app/api/saved-markets/route.ts` JSON parsing | Fixed | Malformed JSON and non-object request bodies fell through to the generic 500 handler for POST/PUT. Added shared `parseJsonObject()` validation so client input errors return explicit 400 responses. |
| CR-003 | Medium | `src/app/api/settings/route.ts` JSON parsing | Fixed | Malformed settings payloads fell through to the generic 500 handler. Reused `parseJsonObject()` before reset/write handling, preserving settings validation and returning explicit 400 input errors. |
| CR-004 | Medium | `src/app/api/manual-matches/route.ts` input validation | Fixed | The route accepted truthy non-string market IDs and arbitrary optional field types. Added a tested parser that requires trimmed string identifiers and rejects malformed optional URLs before persistence. |
| CR-005 | Medium | `src/app/api/all-markets/route.ts` upstream price parsing | Fixed | Raw `parseFloat()` could pass `NaN` into market responses when upstream prices were malformed. Added tested finite non-negative price normalization for Kalshi and Polymarket values. |
| CR-006 | Medium | `src/app/api/logs/route.ts` pagination input | Fixed | Non-finite and fractional `limit` parameters could reach the SQLite query. Added tested finite integer parsing with safe default (100) and documented the actual 500-item maximum. |
| CR-007 | High | `src/app/api/scan-config/route.ts` and persisted scan tiers | Fixed | The persisted config contained an empty tier list, leaving the scheduler unable to qualify markets for scans. Added validated Hot/Warm/Cold tier parsing and automatic fallback to safe defaults. |

## Verification

- Focused test: `src/lib/scan-request.test.ts` — 3 passed.
- Full Vitest: 341 passed, 0 failed.
- Production build: passed.
- Runtime: POST `/api/scan` with `capital: "1000"` returned HTTP 400 with `Invalid capital. Expected a finite number from $1 to $1,000,000.`
- Implementation commits: `f7e00a9` (CR-001), `253c809` (CR-002).
- Runtime proof for CR-002: malformed POST `/api/saved-markets` returns HTTP 400 and `{ "error": "Invalid JSON body" }`.

## Next review module

Continue with a single API route or shared persistence module. Do not combine unrelated cleanup with this review.
