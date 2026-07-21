# CODE-002 Incremental Code Review

This review is intentionally one module and one verified change at a time. Runtime-generated data under `data/` is excluded from code commits.

## Findings

| ID | Severity | Area | Status | Evidence / disposition |
|---|---|---|---|---|
| CR-001 | High | `src/app/api/scan/route.ts` request validation | Fixed | `capital` was accepted directly from JSON. String, `NaN`, `Infinity`, zero, negative, and excessive values could reach fee/stake calculations. Added bounded finite-number validation (`$1`–`$1,000,000`) in `src/lib/scan-request.ts` and a 400 response before any upstream requests. |

## Verification

- Focused test: `src/lib/scan-request.test.ts` — 3 passed.
- Full Vitest: 341 passed, 0 failed.
- Production build: passed.
- Runtime: POST `/api/scan` with `capital: "1000"` returned HTTP 400 with `Invalid capital. Expected a finite number from $1 to $1,000,000.`
- Implementation commit: `f7e00a9`.

## Next review module

Continue with a single API route or shared persistence module. Do not combine unrelated cleanup with this review.
