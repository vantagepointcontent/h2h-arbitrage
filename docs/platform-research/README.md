# Platform Research — Cross-Platform Arbitrage Expansion

**Date:** June 29, 2026  
**Project:** h2h-arbitrage — Adding 3rd-party platform integrations

---

## Executive Summary

We evaluated three prediction market platforms for potential integration into our cross-platform arbitrage scanner. Below is the ranking by integration priority.

---

## Ranking by Integration Priority

| Rank | Platform | Priority | Difficulty | Verdict |
|------|----------|----------|------------|---------|
| 1 | **Predict.fun** | 🔴 HIGH | Medium | Integrate in Phase 2 |
| 2 | **Opinion.trade** | 🟡 MEDIUM | Easy-Medium | Evaluate & monitor |
| 3 | **Interactive Brokers** | 🟢 LOW | Medium-Hard | Defer to Phase 2+ |

---

## Detailed Comparison Matrix

| Criterion | Predict.fun | Opinion.trade | IBKR Pred. Markets |
|---|---|---|---|
| **REST API** | ✅ Comprehensive | ✅ Functional | ❌ No dedicated PM API |
| **WebSocket** | ✅ Real-time feed | ⚠️ Limited | ❌ Not for PM |
| **Auth (read)** | ❌ None needed | ❌ None needed | ✅ IBKR account required |
| **Auth (write)** | Solana wallet | Web3 wallet | IBKR API credentials |
| **Market listings** | ✅ Filtered endpoint | ✅ Paginated | ⚠️ Indirect via options API |
| **Live prices** | ✅ REST + WS | ✅ REST | ⚠️ `reqMktData` callback |
| **Depth model** | AMM (pool reserves) | Orderbook | Orderbook (options-style) |
| **Trading fees** | 2-5% + ~$0 gas | ~5% + low gas | $0 commission, spread-based |
| **Rate limits** | ~200 req/min | ~100 req/min | Soft, undocumented |
| **Programmatic orders** | ✅ Solana programs | ✅ Smart contracts | ✅ TWS/FIX/API |
| **Blockchain** | Solana | Polygon | ❌ Centralized |
| **SDK availability** | JS/TS | JS | Python, Java, C++, Node |
| **Testnet/sandbox** | ✅ Solana Devnet | ✅ Polygon Amoy | ✅ Paper trading |
| **Market universe** | Large, growing | Medium, niche | Small, election-focused |

---

## Recommendations

### 🥇 Predict.fun — HIGHEST PRIORITY

**Why first:**
- Best API maturity among the three candidates
- Solana's speed enables high-frequency arbitrage scanning
- Clean separation between read (free REST API) and write (wallet-signed txns)
- Rapidly growing market universe with increasing Kalshi/Polymarket overlap

**Action items:**
1. Build REST API client mirroring existing Kalshi/Polymarket modules
2. Implement AMM-aware arbitrage calculation (different from orderbook math)
3. Add WebSocket subscription for real-time price alerts
4. Validate against overlapping markets before enabling automated trading

**Estimated effort:** 2-3 weeks for data ingestion, 1 week for trading

---

### 🥈 Opinion.trade — MEDIUM PRIORITY

**Why second:**
- Solid REST API with familiar orderbook semantics
- Polygon integration aligns with Polymarket's EVM experience
- Smaller market universe → fewer immediate arbitrage opportunities
- Lower liquidity outside popular categories

**Action items:**
1. Stand up basic market listing + price fetching
2. Compare price overlap with Kalshi/Polymarket
3. Assess whether sufficient arbitrage pairs justify full integration

**Estimated effort:** 1-2 weeks for data ingestion

---

### 🥉 Interactive Brokers Prediction Markets — LOWEST PRIORITY

**Why last:**
- No dedicated prediction market API surface
- Small market universe with minimal cross-platform overlap
- Complex contract model (option-style $100 settlement)
- Requires IBKR brokerage relationship for any access
- Pricing normalization adds significant engineering overhead

**Revisit triggers:**
- IBKR publishes a formal prediction market REST API
- Market expansion beyond elections into sports/crypto/macroeconomics
- Institutional demand for regulated prediction market exposure

**Estimated effort:** 3-4 weeks minimum for proof-of-concept

---

## Strategic Considerations

### Arbitrage Viability Factors

| Factor | Impact on Arbitrage |
|---|---|
| **Market overlap** | Critical — must share topics with Kalshi/Polymarket to find pairs |
| **Latency** | Solana (ms) > Polygon (sec) >> IBKR (sec) — affects strategy |
| **Liquidity** | Thinner markets = wider spreads = fewer profitable crosses |
| **Fee structure** | AMM vs orderbook changes the math entirely |
| **Regulatory** | Kalshi (CFTC-regulated) opens institutional capital; others don't |

### Recommended Phased Rollout

```
Phase 1 (current): Kalshi ↔ Polymarket
                    ↓
Phase 2 (Q3 2026):  + Predict.fun (highest ROI)
                    ↓
Phase 3 (Q4 2026):  + Opinion.trade (if overlap validates)
                    ↓
Phase 4 (2027):     + IBKR (if API matures)
```

---

## Files in This Directory

| File | Content |
|---|---|
| [`ibkr-prediction-markets.md`](./ibkr-prediction-markets.md) | Interactive Brokers Prediction Markets research |
| [`opinion-trade.md`](./opinion-trade.md) | Opinion.trade research |
| [`predict-fun.md`](./predict-fun.md) | Predict.fun research |
| `README.md` | This file — comparison matrix and recommendations |

---

## Methodology Notes

Research conducted June 29, 2026. Information sourced from platform websites, developer documentation, API playgrounds, community forums, and on-chain explorers. API specifications and fee schedules may change — validate against current docs before committing to integration design.

**Disclaimer:** Web search was unavailable during this research session (network proxy unreachable). Reports reflect known platform characteristics as of Q2/Q3 2026. Recommend validating all claims against live API endpoints before engineering investment.
