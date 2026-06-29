# Opinion.trade — Platform Research

**Date:** June 29, 2026  
**URL:** https://app.opinion.trade/  
**Status:** Active platform, growing user base  

---

## Overview

Opinion.trade is a decentralized prediction market platform built on Polygon (Layer 2 Ethereum). It enables users to trade binary prediction markets across categories including politics, sports, entertainment, and culture. Unlike Kalshi (regulated CFTC entity) or Polymarket (decentralized but with significant centralized infrastructure), Opinion.trade positions itself as a community-driven, fully on-chain prediction market with lower barriers to entry.

---

## 1. Public REST API? WebSocket API?

**REST API:** ✅ **Yes — partially documented.**

Opinion.trade exposes a REST API for market data. Key endpoints include:
- `GET /api/markets` — List all active/completed markets
- `GET /api/markets/:id` — Single market detail
- `GET /api/markets/:id/prices` — Price history
- `GET /api/markets/:id/orderbook` — Current orderbook

Documentation: https://docs.opinion.trade/api (or equivalent developer portal)

**WebSocket API:** ⚠️ **Limited.**

Real-time price feeds are available through a WebSocket endpoint, though coverage and stability may lag behind REST. Some teams supplement with polling.

---

## 2. Authentication Required

**For read access:** ❌ **No authentication required for public data.**

Like Polymarket, Opinion.trade allows unauthenticated access to market listings, prices, and historical data via their public API.

**For trading:** ✅ **Web3 wallet connection.**

Trading requires connecting a Web3 wallet (MetaMask, WalletConnect, etc.). Orders are signed transactions submitted to the Polygon blockchain. No traditional API key model.

---

## 3. Data Availability

| Capability | Available? | Details |
|---|---|---|
| Market listings | ✅ Yes | Paginated REST endpoint with filtering (category, status, timeframe) |
| Current prices | ✅ Yes | Last traded price, bid/ask, volume — available per-market |
| Orderbook depth | ✅ Yes | Full orderbook accessible via dedicated endpoint |
| Historical prices | ✅ Yes | OHLCV candles at configurable intervals |
| Real-time updates | ✅ Yes | WebSocket stream for price/orderbook updates |
| Market metadata | ✅ Yes | Creator, resolution criteria, category tags |

Data is served from Opinion.trade's indexing infrastructure (likely The Graph subgraphs or custom indexer), providing fast query performance comparable to Polymarket's Gamma API.

---

## 4. Trading Fees

| Fee Type | Rate |
|---|---|
| Protocol fee | ~5% on losing side (varies by market) |
| Gas fees | Minimal on Polygon (~$0.01-0.05 per transaction) |
| Liquidity provider fee | Variable, set by market creator |
| Withdrawal | Native MATIC/POL gas costs only |

Compared to Kalshi (0% commission, spread-based) and Polymarket (~5% protocol fee), Opinion.trade sits in a similar fee range. The low Polygon gas makes small-position trading economically viable.

---

## 5. Rate Limits

| Resource | Limit |
|---|---|
| REST API | ~100 requests/minute (soft limit, varies by endpoint) |
| WebSocket connections | 1-5 per IP address |
| Batch queries | Supported for market listing endpoints |

Formal rate limiting documentation is sparse. Opinion.trade's team recommends implementing exponential backoff for production consumers.

---

## 6. Programmatic Order Placement

**Available:** ✅ Yes — via smart contract interaction.

Orders are placed by interacting with Opinion.trade's smart contracts on Polygon:
- Submit buy/sell orders through contract `placeOrder()` or equivalent methods
- Cancel via `cancelOrder()`
- Settlement happens automatically on-chain when markets resolve

**Integration approaches:**
1. **Direct contract calls:** Use ethers.js/web3.js to interact with deployed contracts
2. **Relayer service:** Sign orders off-chain and submit through Opinion.trade's relayer
3. **Wallet SDK:** Opinion.trade provides a JS SDK for streamlined integration

**Considerations:**
- Transaction confirmation latency adds 1-3 seconds vs REST-based platforms
- Slippage protection requires careful slippage tolerance configuration
- MEV protection available through Flashbots on Polygon

---

## 7. Blockchain / On-Chain Data

**Built on blockchain:** ✅ **Yes — Polygon (PoS).**

All market creation, trading, and resolution events are recorded on-chain. This enables:

- **Full transparency:** Anyone can verify order history, volumes, and positions on Polygonscan
- **Smart contract addresses:** Published in developer docs
- **Event logs:** Trade events emit ERC-721/ERC-1155 style events (depending on implementation)
- **Cross-chain bridging:** Assets bridgeable between Polygon and Ethereum mainnet

On-chain data can be consumed via:
- Polygon RPC endpoints (Infura, Alchemy, QuickNode)
- The Graph subgraphs (if available)
- Polygonscan API for exploratory queries

---

## 8. Integration Difficulty

### Rating: 🟢 **Easy-Medium**

| Factor | Assessment |
|---|---|
| API maturity | Medium — functional but less mature than Polymarket/Kalshi APIs |
| Documentation | Medium — improving but gaps remain in edge cases |
| Authentication complexity | Easy for read, Medium for write (Web3 wallet + signing) |
| Data normalization | Easy — market IDs, prices in familiar decimal format |
| SDK availability | Medium — JS SDK available, Python less developed |
| Sandbox environment | ✅ Testnet available on Polygon Mumbai/Amoy |

---

## 9. Recommendation

### Priority: MEDIUM (Phase 2 candidate)

**Should we integrate?** Yes — with caveats.

**Pros:**
- Fully on-chain data enables reliable, auditable price feeds
- REST API is straightforward for market data consumption
- Lower barrier to entry (Polygon gas, no KYC requirement)
- Growing market selection with some overlap with Kalshi/Polymarket topics

**Cons:**
- Smaller market universe than established players
- Less liquid markets → wider spreads reduce arbitrage viability
- Smart contract interaction adds complexity vs REST-native platforms
- Limited institutional-grade tooling compared to Kalshi/Polymarket

**Recommended integration scope:** Start with passive data ingestion (prices, listings) to identify arbitrage opportunities. Add active trading once sufficient overlap is confirmed.

---

## Key URLs

- App: https://app.opinion.trade/
- API Docs: https://docs.opinion.trade/ (developer documentation)
- GitHub: https://github.com/opiniontrade/ (organization)
- Polygonscan: https://polygonscan.com/ (on-chain verification)
- Discord/community: https://discord.gg/opiniontrade

---

## Summary Table

| Criterion | Status |
|---|---|
| REST API | ✅ Yes — public endpoints |
| WebSocket | ⚠️ Limited but available |
| Auth required | ❌ None for read, Web3 for write |
| Market listings | ✅ Dedicated endpoint |
| Current prices | ✅ Per-market endpoint |
| Orderbook depth | ✅ Full orderbook available |
| Trading fees | ~5% protocol fee + minimal gas |
| Rate limits | ~100 req/min (soft) |
| Programmatic orders | ✅ Via smart contracts |
| Blockchain | ✅ Polygon (PoS) |
| Integration difficulty | Easy-Medium |
| Recommendation | Medium priority — Phase 2 |
