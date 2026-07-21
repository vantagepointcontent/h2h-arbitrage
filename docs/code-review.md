# CODE-002 Incremental Code Review

This review is intentionally one module and one verified change at a time. Runtime-generated data under `data/` is excluded from code commits.

## Findings

| ID | Severity | Area | Status | Evidence / disposition |
|---|---|---|---|---|
| CR-001 | High | `src/app/api/scan/route.ts` request validation | Fixed | `capital` was accepted directly from JSON. String, `NaN`, `Infinity`, zero, negative, and excessive values could reach fee/stake calculations. Added bounded finite-number validation (`$1`–`$1,000,000`) in `src/lib/scan-request.ts` and a 400 response before any upstream requests. |
| CR-002 | Medium | `src/app/api/saved-markets/route.ts` JSON parsing | Fixed | Malformed JSON and non-object request bodies fell through to the generic 500 handler for POST/PUT. Added shared `parseJsonObject()` validation so client input errors return explicit 400 responses. |
| CR-003 | Medium | `src/app/api/settings/route.ts` JSON parsing | Fixed | Malformed settings payloads fell through to the generic 500 handler. Reused `parseJsonObject()` before reset/write handling, preserving settings validation and returning explicit 400 input errors. |

## Verification

- Focused test: `src/lib/scan-request.test.ts` — 3 passed.
- Full Vitest: 341 passed, 0 failed.
- Production build: passed.
- Runtime: POST `/api/scan` with `capital: "1000"` returned HTTP 400 with `Invalid capital. Expected a finite number from $1 to $1,000,000.`
- Implementation commits: `f7e00a9` (CR-001), `253c809` (CR-002).
- Runtime proof for CR-002: malformed POST `/api/saved-markets` returns HTTP 400 and `{ "error": "Invalid JSON body" }`.

## Next review module

Continue with a single API route or shared persistence module. Do not combine unrelated cleanup with this review.
