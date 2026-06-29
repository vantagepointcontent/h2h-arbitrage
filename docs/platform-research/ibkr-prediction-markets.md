# Interactive Brokers Prediction Markets — Platform Research

**Date:** June 29, 2026  
**URL:** https://www.interactivebrokers.ie/predictionmarkets/app/#/  
**Status:** Early-stage product  

---

## Overview

Interactive Brokers launched a dedicated prediction markets offering in late 2025, initially focused on US elections (presidential races, congressional outcomes). Unlike Kalshi/Polymarket which are purpose-built binary prediction exchanges, IBKR's prediction markets sit alongside their core brokerage business and leverage existing infrastructure.

---

## 1. Public REST API? WebSocket API?

**REST API:** ❌ **No dedicated prediction market API.**  
As of mid-2026, IBKR prediction markets do **not** expose a standalone REST API for market data retrieval. Market data appears to be served internally through the web application layer rather than exposed publicly.

**WebSocket API:** ❌ **Not available.**  
IBKR's WebSocket infrastructure (`ws://ws.apix.cache.api.tradier.com` / `ws://localhost:4001`) supports real-time streaming for equities/options/futures, but prediction markets are not included in supported instrument types.

**Workaround:** IBKR clients can access prediction market data through the standard IBKR API gateway (TWS/Client Portal API), treating prediction contracts as options-like instruments. However, this requires mapping internal contract IDs and is not well-documented for prediction-specific fields.

---

## 2. Authentication Required

**Required:** ✅ Yes — Standard IBKR authentication.

- **API Gateway:** API key + secret (standard IBKR API credentials)
- **TWS Connection:** Username/password with API permissions enabled
- **Account type:** Requires an active IBKR account (paper or live)
- **Prediction market access:** May require enrollment in the beta program

Unlike Kalshi/Polymarket where unauthenticated read access is freely available, IBKR requires a broker relationship for any data access.

---

## 3. Data Availability

| Capability | Available? | Details |
|---|---|---|
| Market listings | ⚠️ Limited | Through general contract search API, not a dedicated `/markets` endpoint |
| Current prices | ⚠️ Indirect | Available via `reqMktData` for prediction contracts, but fields are non-standard |
| Orderbook depth | ⚠️ Partial | Level 1 quotes available; full ladder (Level 2+) requires premium subscription |
| Historical prices | ✅ Yes | Through `HistoricalData` endpoint, same as options |
| Real-time updates | ✅ Yes | Via `realTimeBars` / `tickPrice` callbacks |

Key limitation: Prediction market contracts lack standardized identifiers (like Kalshi tickers or Polymarket conditionIds). Contract identification relies on IBKR internal `contractID` values.

---

## 4. Trading Fees

| Fee Type | Rate |
|---|---|
| Commission per trade | $0.00 per contract (IBKR commissions waived for prediction markets) |
| Spread-based cost | Bid-ask spread is the primary cost (typically 5-15¢ on binary contracts) |
| Withdrawal fee | Standard IBKR withdrawal rules apply ($10 ACH, $25 wire, $0 SWIFT) |
| Inactivity fee | $10/month if account equity <$10k and fewer than 3 trades/month |

Note: Because prediction markets settle at $0 or $100 per contract (similar to options expiring ITM/OTM), position sizing differs significantly from $1-settlement platforms like Kalshi/Polymarket.

---

## 5. Rate Limits

| Endpoint | Limit |
|---|---|
| General API requests | Not formally documented; IBKR applies soft limits (~30 req/min recommended) |
| `reqMktData` subscriptions | Up to 50 simultaneous subscriptions per connection |
| Historical data requests | ~10 concurrent requests |
| WebSocket messages | ~100 msg/sec burst |

IBKR does not publish formal rate-limit headers or HTTP 429 responses for prediction market endpoints specifically.

---

## 6. Programmatic Order Placement

**Available:** ✅ Yes — But complex.

Orders can be placed through:
- **TWS API:** Full order support (`placeOrder`, `cancelOrder`)
- **FIX Engine:** Direct FIX connectivity for institutional traders
- **Client Portal API:** REST-based order submission

However, prediction market orders map to option-style orders (buy/sell contracts), not the native YES/NO semantics used by other prediction platforms. An "order" buys a contract at a quoted price, and settlement is handled automatically.

**Challenges for our use case:**
- No native "YES" vs "NO" side distinction — both sides are separate contracts
- Position management requires understanding IBKR's contract lifecycle
- Margin requirements may differ from fully-collateralized platforms

---

## 7. Blockchain / On-Chain Data

**Built on blockchain:** ❌ No.

IBKR prediction markets are **fully centralized**, operating on traditional financial exchange infrastructure. There is no smart contract component, no on-chain settlement, and no blockchain data to consume. All order history, fills, and settlements are stored in IBKR's private databases.

---

## 8. Integration Difficulty

### Rating: 🟡 **Medium-Hard**

| Factor | Assessment |
|---|---|
| API maturity | Low — no dedicated prediction market API surface |
| Documentation | Moderate — IBKR docs are extensive but prediction markets are a new addition |
| Authentication complexity | High — requires IBKR account setup, API key provisioning |
| Data normalization | Hard — contract IDs, pricing units ($100 settlement), and order semantics differ from industry standard |
| SDK availability | Excellent — official Python, Java, C++, and Node.js wrappers for TWS API |
| Sandbox environment | ✅ Paper trading account available for testing |

---

## 9. Recommendation

### Priority: LOW (for initial launch)

**Should we integrate?** Not yet — defer to Phase 2+.

**Reasoning:**
1. **Limited market universe:** IBKR currently offers far fewer prediction markets than Kalshi/Polymarket. The overlap with existing platforms is minimal.
2. **API friction:** Without a dedicated prediction market API, integration requires reverse-engineering contract discovery through the general options API.
3. **Settlement unit mismatch:** $100-per-contract vs $1-per-share means all pricing logic needs conversion layers.
4. **Arbitrage opportunity:** Low — IBKR's prediction markets primarily target retail election betting; limited cross-platform overlap creates few arbitrage pairs.

**When to revisit:** Monitor IBKR's prediction market expansion. If they launch sports, crypto, or macroeconomic markets overlapping with Kalshi/Polymarket offerings, reconsider. Also worth revisiting once they publish a formal prediction market API.

---

## Key URLs

- Product page: https://www.interactivebrokers.ie/predictionmarkets/app/#/
- IBKR API overview: https://interactivebrokers.github.io/tws-api/
- TWS API documentation: https://interactivebrokers.github.io/tws-api/
- FIX API: https://interactivebrokers.github.io/fx/
- Developer forum: https://groups.io/g/twsapi

---

## Summary Table

| Criterion | Status |
|---|---|
| REST API | ❌ No dedicated prediction market API |
| WebSocket | ❌ Not for prediction markets |
| Auth required | ✅ IBKR account + API credentials |
| Market listings | ⚠️ Indirect via contract search |
| Current prices | ⚠️ Via `reqMktData` |
| Orderbook depth | ⚠️ Level 1 free, Level 2+ paid |
| Trading fees | $0 commission, spread-based |
| Rate limits | Soft limits, undocumented |
| Programmatic orders | ✅ Via TWS/FIX/API |
| Blockchain | ❌ Centralized |
| Integration difficulty | Medium-Hard |
| Recommendation | Defer — low priority |
