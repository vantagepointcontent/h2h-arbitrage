# DATA-007: Authoritative Execution Metadata Contract

## Summary

This document records the new shared execution evidence contract and its integration points across the EdgeFinder system.

## The Contract

**Location:** `src/lib/execution-evidence.ts`

### Live Execution Evidence (authoritative)

A live execution must provide, for both legs:

- **filledQuantity** — venue-reported contracts/shares
- **fillPrice** — venue-reported fill price
- **chargedFeeCents** — required venue-reported fee in integer cents (explicit zero is valid; missing is not)
- **executionId** — venue-provided order/trade identifier
- **venueTimestamp** — venue-provided execution timestamp
- **venue** — 'kalshi' or 'polymarket'

The top-level `LiveExecutionEvidence` requires:

- **kind: 'live'**
- **kalshi** + **polymarket** — both legs authoritative
- **contractsMatched: true** — both legs have matching quantities
- **actualProfit** — net actual profit from venue data

### Paper Execution Evidence (non-authoritative)

- **kind: 'paper'**
- Simulated legs with executionId, fillPrice, and filledQuantity
- Always considered ineligible for analytics

## API Surface

| Export | Purpose |
|--------|---------|
| `isAuthoritativeVenueEvidence` | Guard for a single leg |
| `isAuthoritativeLiveEvidence` | Guard for a complete live execution |
| `buildExecutionEvidence(result, dryRun)` | Produce evidence from an `ExecutionResult` |
| `orderResultToVenueEvidence(order)` | Promote an `OrderResult` to evidence |
| `getAuthoritativeMatchedFill({kalshiResult, polymarketResult})` | Validate matched fills or return null |
| `isAnalyticsEligible(result, evidence)` | True only for clean, confirmed live executions |

## Affected Adapters and Call Paths

### 1. auto-execute.ts

- **Where:** `placeRealKalshiLeg`, `placeRealPmLeg`, and `pollOrder` populate `OrderResult` from venue responses.
- **Kalshi behavior:** `mapKalshiOrderResult` now promotes only correlated `GET /portfolio/fills?order_id=...` evidence. Requested price, calculated fee, order ID as trade ID, and local-clock timestamps are not used. Missing evidence keeps the leg non-verified and prevents live success.
- **Path:** `executeArb` → `placeRealKalshiLeg` / `placeRealPmLeg` → venue API.

### 2. kalshi-orders.ts

- **Where:** `KalshiOrderResponse`, `getKalshiFillEvidence`, `getKalshiOrder`, and `placeKalshiOrder`.
- **Evidence source:** Kalshi `Fill` records provide `count_fp`, side-specific `*_price_dollars`, `fee_cost`, `fill_id`/`trade_id`, `created_time`, `order_id`, ticker, and outcome side. Every association is validated against the submitted order before promotion.
- **Path:** `placeKalshiOrder` / `getKalshiOrder` → correlated `GET /trade-api/v2/portfolio/fills?order_id=...`.

### 3. polymarket-orders.ts

- **Where:** `PmOrderResponse`, `placePmOrder`, and `getPmOrder`.
- **What's needed:** The `raw` field carries the CLOB response. Future refinement must extract any `takerFee` or `feeRate` and the order-level `created_at` or `matched_at` timestamp and pass them up to `auto-execute.ts`.
- **Path:** `placePmOrder` → `ClobClient.createAndPostOrder`.

### 4. bot-trader.ts

- **Where:** `maybeExecuteBotTrade` already calls `getAuthoritativeMatchedFill` (re-exported from `execution-evidence.ts`) and uses `result.kalshiResult.filledContracts`.
- **What's needed:** No immediate change required. The contract is validated before position persistence, and paper/live are already disambiguated by `effectiveDryRun`. A future refinement can replace the existing custom logic with `buildExecutionEvidence(result, effectiveDryRun)` for a single canonical evidence object.

### 5. persistence.ts

- **Where:** `ExecutionRecord` and `persistExecution`.
- **What's needed:** No schema migration needed now. The `execution-evidence.ts` contract is purely in-memory. When downstream workers need evidence in the DB, a future ticket can add a `result` JSON column or a new `execution_evidence` table.

### 6. bot-positions.ts

- **Where:** `recordBotPosition` and the `BotPosition` type.
- **What's needed:** Currently positions are created from local values (`kalshiPrice`, `pmPrice`, etc.). A future refinement should check for authoritative evidence and store `venueExecutionId` fields on positions so the UI can link back to exchange trades.

## Validation Rules (for downstream consumers)

1. A live execution **must** have both legs present and authoritative.
2. The **orderId** (executionId) must be a non-empty string traceable to the venue.
3. The **timestamp** must be a valid timezone-qualified ISO 8601 string from the venue, not `new Date().toISOString()`.
4. The **fillPrice** must be `> 0 && < 1` (or `0.01` to `0.99` for the CLOB engines).
5. The **filledQuantity** must be a safe non-negative integer.
6. The **actualProfit** must be a finite number.
7. **Paper** executions must always return `isAnalyticsEligible === false`.

## Testing

- **Test file:** `src/lib/execution-evidence.test.ts`
- **Tests written:** 44
- **Coverage:**
  - `isAuthoritativeVenueEvidence` — 13 tests (valid, missing, edge values)
  - `isAuthoritativeLiveEvidence` — 9 tests (matched, mismatched, kind, venues)
  - `orderResultToVenueEvidence` — 8 tests (complete, missing fields, malformed)
  - `buildExecutionEvidence` — 5 tests (paper, live, missing orderId, mismatched)
  - `getAuthoritativeMatchedFill` — 7 tests (match, mismatch, missing, boundaries)
  - `isAnalyticsEligible` — 6 tests (live, paper, null, rollback, unhedged, failed)

## Deployment Notes

- This ticket **does not** modify `npm run build` or `npm run lint`.
- No database migrations are required.
- No live orders are placed.
- The `bot-trader.ts` file has **not** been changed outside of re-exporting `getAuthoritativeMatchedFill`.

## Future Work (not in this ticket)

- Enrich `polymarket-orders.ts` to forward its authoritative fee and venue timestamp fields.
- Integrate `buildExecutionEvidence` into `bot-trader.ts` to replace the existing custom matched-fill logic.
- Surface `ExecutionEvidence` in the database and UI for full auditability.
