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
| CR-008 | Medium | `src/app/api/auto-discovery/approve/route.ts` approval input | Fixed | Malformed JSON and arbitrary/oversized pair IDs could reach a state-changing approval operation. Added shared JSON-object parsing and tested trimmed, bounded pair-ID validation. |
| CR-009 | Medium | `src/app/api/pm-tokens/route.ts` CLOB condition ID | Fixed | The condition ID was interpolated into an external API path without format validation. Added tested validation for Polymarket's canonical 0x-prefixed 32-byte IDs. |
| CR-010 | Medium | `src/app/api/lifecycle/route.ts` state-changing request parsing | Fixed | Malformed JSON produced a 500 response, while object-valued IDs were coerced to `"[object Object]"` before persistence. Added shared JSON-object parsing and a tested lifecycle-request parser that permits only known actions and non-empty string IDs. |
| CR-011 | Medium | `src/app/api/couplings/route.ts` rejection input | Fixed | Malformed payloads produced 500s and missing or non-string market identifiers could create blank or malformed persisted rejection records. Added shared JSON parsing and tested action/identifier validation before any state write. |
| CR-012 | Medium | `src/app/api/watcher/targets/route.ts` promotion input | Fixed | The authenticated promotion endpoint allowed arbitrary truthy `pairId` values and accepted JSON arrays as request bodies. Added shared JSON-object parsing and tested, bounded non-empty string validation for promotion IDs. |
| CR-013 | High | `src/app/api/telegram-alerts/route.ts` test-message action | Fixed | A LAN caller could trigger a real configured Telegram test message without the shared API-token guard; malformed request data also became 500s. Added mutating-route authorization plus tested JSON/action validation. No test message was sent during verification. |

## Verification

- Focused test: `src/lib/scan-request.test.ts` — 3 passed.
- Full Vitest: 341 passed, 0 failed.
- Production build: passed.
- Runtime: POST `/api/scan` with `capital: "1000"` returned HTTP 400 with `Invalid capital. Expected a finite number from $1 to $1,000,000.`
- Implementation commits: `f7e00a9` (CR-001), `253c809` (CR-002).
- Runtime proof for CR-002: malformed POST `/api/saved-markets` returns HTTP 400 and `{ "error": "Invalid JSON body" }`.

## Next review module

Continue with a single API route or shared persistence module. Do not combine unrelated cleanup with this review.
