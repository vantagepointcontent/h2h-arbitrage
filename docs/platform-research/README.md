# Prediction-market platform API reconnaissance

Research date: 2026-07-20. This is an architecture input, not authorization to place trades.

## Recommendation

1. **Opinion.trade — first additional data integration.** Documented REST market/orderbook API, WebSocket, API-key authentication, and CLOB SDK for trading. Medium implementation effort.
2. **Predict.fun — second.** Broad documented beta API (markets, orderbooks, orders, JWT auth and WebSocket). Medium effort, but beta/API stability risk.
3. **IBKR Prediction Markets — last.** Powerful general Client Portal API, but account, IBKR Pro, funded-account, 2FA and market-entitlement constraints make it high-friction. Validate prediction-market contract access before implementation.

## Interactive Brokers Prediction Markets

- **API:** Client Portal Web API supports HTTP and WebSocket access to trading, market data, scanners, and portfolio updates.
- **Auth/account:** Active, funded **IBKR Pro** account plus supported 2FA. Demo accounts cannot subscribe to data. Supports OAuth 1.0a/2.0, SSO, or CP Gateway.
- **Market data/orderbook:** General API supports live market data and portfolio updates; prediction-market contract discovery and entitlements require a live-account proof of access.
- **Trading:** General API supports trading, but this project must retain manual-only execution and the server-side kill switch.
- **Difficulty:** Hard — broker account/permissions/compliance and contract identifiers are the dependency.
- **Next proof:** create a read-only adapter spike after an IBKR Pro account and prediction-market market-data entitlement are confirmed.
- **Source:** https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/

## Opinion.trade

- **Read API:** REST OpenAPI exposes market metadata, prices, orderbooks, volumes, history and pagination.
- **Realtime:** authenticated WebSocket supports market, price, orderbook and event updates.
- **Auth/rate limit:** API key, 15 requests/sec per key. Access is requested through Opinion's application process.
- **Trading:** the OpenAPI is read-only; place/cancel orders and positions use the Opinion CLOB SDK.
- **Chain:** BNB Chain mainnet (chain ID 56).
- **Difficulty:** Medium — clean documented read path; trading requires SDK/wallet work.
- **Example market list:**
  ```bash
  curl 'https://proxy.opinion.trade:8443/openapi/market?status=activated&sortBy=5&limit=20' \
    -H 'apikey: YOUR_API_KEY'
  ```
- **Sources:**
  - https://docs.opinion.trade/developer-guide/opinion-open-api/overview
  - https://docs.opinion.trade/developer-guide/opinion-websocket/overview

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
- Keep Opinion, Predict.fun and IBKR adapters read-only/stubbed until their credential and entitlement proof is complete.
- Any execution adapter remains manual-only, dry-run by default, and behind the existing kill switch.
