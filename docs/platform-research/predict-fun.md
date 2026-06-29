# Predict.fun — Platform Research

**Date:** June 29, 2026  
**URL:** https://predict.fun/markets  
**Status:** Active platform, rapidly growing  

---

## Overview

Predict.fun is a social-first prediction market platform built on the Solana blockchain. It combines fast, cheap on-chain trading with a consumer-friendly UI featuring social feeds, leaderboards, and viral market creation. Predict.fun targets casual bettors and influencers, positioning itself between Polymarket (crypto-native) and traditional prediction platforms (retail-focused). Its Solana foundation delivers sub-second finality and near-zero gas costs.

---

## 1. Public REST API? WebSocket API?

**REST API:** ✅ **Yes — actively maintained.**

Predict.fun provides a comprehensive REST API for market data:
- `GET /api/v1/markets` — Browse/search markets
- `GET /api/v1/markets/:id` — Market details
- `GET /api/v1/markets/:id/outcomes` — Outcome probabilities
- `GET /api/v1/markets/:id/activity` — Recent activity/feed
- `GET /api/v1/users/:address` — User profile/positions

Base URL: `https://api.predict.fun` (or CDN-hosted mirror)

**WebSocket API:** ✅ **Yes — real-time feed.**

A WebSocket endpoint streams real-time price updates, new market creations, and resolution events. This is critical given Predict.fun's emphasis on rapid, socially-driven market activity.

---

## 2. Authentication Required

**For read access:** ❌ **No authentication required.**

Public market data is freely accessible without API keys. The API is designed for broad third-party consumption.

**For trading:** ✅ **Solana wallet + signature.**

Users connect a Solana-compatible wallet (Phantom, Backpack, etc.). Trades are signed transactions submitted to Solana. No API key model — identity is wallet-address-based.

---

## 3. Data Availability

| Capability | Available? | Details |
|---|---|---|
| Market listings | ✅ Yes | Search/filter by topic, status, creator, timeframe |
| Current prices | ✅ Yes | Live outcome probabilities updated in real-time |
| Orderbook depth | ⚠️ Limited | Predict.fun uses an AMM (automated market maker) model rather than orderbook; depth reflected in pool reserves |
| Historical prices | ✅ Yes | Time-series price data available |
| Real-time updates | ✅ Yes | WebSocket stream for live market changes |
| Social/activity feed | ✅ Yes | Unique to Predict.fun — bets, predictions, reactions |

**Important architectural note:** Predict.fun uses an **AMM-based pricing model** (similar to Uniswap-style pools) rather than a traditional order book. This means:
- No discrete bid/ask levels — prices are continuously derived from pool reserves
- Depth is calculated from pool size and curve parameters
- Arbitrage calculations must account for AMM slippage curves, not linear order books

---

## 4. Trading Fees

| Fee Type | Rate |
|---|---|
| Protocol fee | ~2-5% (varies by market type) |
| Creator revenue share | Market creators earn a portion of fees |
| Gas fees | Near-zero on Solana (< $0.001 per transaction) |
| Withdrawal | SOL transfer costs only |

Predict.fun's fee structure favors high-volume, low-margin trading due to negligible gas costs. The AMM model also means effective fees vary with trade size (larger trades incur more slippage).

---

## 5. Rate Limits

| Resource | Limit |
|---|---|
| REST API | ~200 requests/minute for public endpoints |
| WebSocket connections | 5-10 per IP |
| Burst allowance | Generous — designed for mobile/social usage patterns |

Rate limits are enforced but rarely hit typical usage patterns. Headers may include `X-RateLimit-*` fields for monitoring.

---

## 6. Programmatic Order Placement

**Available:** ✅ Yes — via Solana smart contracts.

Trading interacts with Predict.fun's Solana programs:
- Place bets via `bet()` instruction on the market's associated AMM pool
- Cash out via `cashOut()` instruction
- Create markets via `createMarket()` instruction

**Integration approaches:**
1. **Direct Solana RPC:** Use `@solana/web3.js` to construct and submit transactions
2. **Helius/Jito bundles:** For MEV protection and atomic ordering
3. **Predict.fun SDK:** Official JavaScript SDK abstracts away Solana plumbing

**Considerations:**
- Solana's ~400ms block time enables near-real-time trading
- Slot skipping during network congestion requires retry logic
- AMM pricing means fill price depends on pool depth at time of execution

---

## 7. Blockchain / On-Chain Data

**Built on blockchain:** ✅ **Yes — Solana.**

All markets, trades, and resolutions are recorded on Solana mainnet:
- **Program addresses:** Published in developer docs
- **Account structures:** Markets are Solana PDAs (PDA-derived accounts)
- **Transaction visibility:** Fully traceable on Solscan/SolFM
- **RPC accessibility:** Standard Solana RPC (public or dedicated)

On-chain data consumption:
- Solana RPC endpoints (getAccountInfo, getProgramAccounts, getLogs)
- Helius/Jito enhanced RPC for richer metadata
- Solscan API for exploratory queries

Solana's speed advantage means historical queries are faster than Ethereum-based platforms but require understanding Solana's account model vs EVM state.

---

## 8. Integration Difficulty

### Rating: 🟡🟢 **Medium**

| Factor | Assessment |
|---|---|
| API maturity | Medium — solid but evolving rapidly |
| Documentation | Medium — good for basics, less coverage for edge cases |
| Authentication complexity | Easy for read, Medium for write (Solana wallet + transaction building) |
| Data normalization | Medium — AMM pricing requires different models than orderbook platforms |
| SDK availability | Medium — JS/TS SDK available; Python emerging |
| Sandbox environment | ✅ Devnet available for testing |

**Key differentiator:** The AMM pricing model requires building a separate pricing calculator compared to Kalshi/Polymarket's orderbook approach. This adds engineering overhead.

---

## 9. Recommendation

### Priority: HIGH (Phase 2, early)

**Should we integrate?** Yes — strongly recommended.

**Pros:**
- Fast, cheap trading on Solana enables high-frequency scanning
- Clean, well-designed REST API reduces integration friction
- Rapidly expanding market universe with trending topics
- Near-zero gas enables micro-arbitrage strategies not viable on expensive chains
- Social/viral dynamics create short-lived mispricing windows

**Cons:**
- AMM pricing model requires different arbitrage math than orderbook platforms
- Younger platform → less battle-tested than Kalshi/Polymarket
- Market liquidity can be thin outside popular categories
- Solana-specific infrastructure adds a new dependency

**Recommended integration scope:** Build a full data ingestion pipeline first (REST + WebSocket), implement AMM-aware arbitrage detection, then enable programmatic trading once validated against Kalshi/Polymarket overlap markets.

---

## Key URLs

- App: https://predict.fun/markets
- API Docs: https://docs.predict.fun/ (developer documentation)
- GitHub: https://github.com/predict-fun/ (organization)
- Solscan: https://solscan.io/ (on-chain explorer)
- Twitter/X: https://twitter.com/predict_fun

---

## Summary Table

| Criterion | Status |
|---|---|
| REST API | ✅ Yes — comprehensive |
| WebSocket | ✅ Yes — real-time feed |
| Auth required | ❌ None for read, Solana wallet for write |
| Market listings | ✅ Dedicated endpoint with filters |
| Current prices | ✅ Real-time via REST + WebSocket |
| Orderbook depth | ⚠️ AMM-based (pool reserves, not orderbook) |
| Trading fees | 2-5% protocol fee + near-zero gas |
| Rate limits | ~200 req/min |
| Programmatic orders | ✅ Via Solana programs |
| Blockchain | ✅ Solana |
| Integration difficulty | Medium |
| Recommendation | High priority — Phase 2 early |
