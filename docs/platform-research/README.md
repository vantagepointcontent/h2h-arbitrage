# Prediction-market platform API reconnaissance

Research date: 2026-07-20. This is an architecture input, not authorization to place trades.

## Recommendation

1. **IBKR Prediction Markets — investigate first.** Validate contract access, market-data entitlements, and the supported API surface before implementation.
2. **Predict.fun — deferred.** Broad documented beta API (markets, orderbooks, orders, JWT auth and WebSocket), but beta/API stability risk.

## Interactive Brokers Prediction Markets

- **API:** Client Portal Web API supports HTTP and WebSocket access to trading, market data, scanners, and portfolio updates.
- **Auth/account:** Active, funded **IBKR Pro** account plus supported 2FA. Demo accounts cannot subscribe to data. Supports OAuth 1.0a/2.0, SSO, or CP Gateway.
- **Market data/orderbook:** General API supports live market data and portfolio updates; prediction-market contract discovery and entitlements require a live-account proof of access.
- **Trading:** General API supports trading, but this project must retain manual-only execution and the server-side kill switch.
- **Difficulty:** Hard — broker account/permissions/compliance and contract identifiers are the dependency.
- **Next proof:** create a read-only adapter spike after an IBKR Pro account and prediction-market market-data entitlement are confirmed.
- **Source:** https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/


## Predict.fun

- **API:** beta REST API documents categories, markets, market statistics, orderbooks, time series, orders and order-match events.
- **Realtime:** WebSocket market/account streams; JSON frames. Server heartbeats every 15 seconds must be echoed, with reconnect + re-subscribe support.
- **Auth:** signed auth message -> JWT flow. Docs include TypeScript and Python auth guides.
- **Trading:** documented create/cancel orders, plus order retrieval. Treat beta stability as an operational risk.
- **Difficulty:** Medium — API surface is broad; wallet/signing and beta compatibility need a proof-of-concept.
- **Example orderbook endpoint:**
  ```bash
  curl 'https://api.predict.fun/v1/markets/MARKET_ID/orderbook'
  ```
- **Sources:**
  - https://dev.predict.fun/
  - https://dev.predict.fun/general-information-1915499m0

## Architecture implications

- Registry/adapters are justified, but **do not** refactor all existing PM/Kalshi code in one untested sweep.
- Finish FEAT-1 registry and FEAT-2 adapter contracts first.
- Keep Predict.fun and IBKR adapters read-only/stubbed until their credential and entitlement proof is complete.
- Any execution adapter remains manual-only, dry-run by default, and behind the existing kill switch.
