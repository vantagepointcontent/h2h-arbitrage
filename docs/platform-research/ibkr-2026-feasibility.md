# IBKR integration feasibility — 2026-07-22

**Decision:** do not build an IBKR adapter yet. Run a manual, read-only proof of access first.

## What EdgeFinder can use

For a Next.js application, IBKR's **Client Portal Web API (CPAPI)** is the candidate surface for a later read-only adapter: it supports HTTPS and WebSocket access to live market data, scanners, and intraday portfolio updates. Its protected `/iserver` resources require an active brokerage session.

The **TWS API / IB Gateway** is the alternative for a richer, long-running data connection. It is a TCP socket API with broad TWS feature parity, but requires local TWS or IB Gateway and a separate service/bridge; it is not a direct Node/Next.js HTTP integration.

## Hard prerequisites

IBKR's official requirements for CPAPI and TWS API are:

- Opened, **funded IBKR Pro** account. Demo accounts cannot subscribe to data.
- Supported 2FA; 2FA is required.
- For individual CPAPI users: the Java Client Portal Gateway runs locally, browser authentication occurs on that same machine, and API requests must originate on that machine.
- CP Gateway authentication is not automatable for individual clients; IBKR says users must reauthenticate at least once after midnight daily.
- Only one trading-enabled brokerage session can be open per username at a time. `/iserver` market-data and order endpoints require that brokerage session.

## Implications for EdgeFinder

1. **No always-on server poller until entitlement is proven.** A cloud/server-side poller cannot safely assume it can maintain an individual CP Gateway session.
2. **Start with an explicitly local read-only spike.** Run the gateway beside the account holder's browser, find a prediction-market contract, then request its quote and depth. Do not add credentials to EdgeFinder.
3. **Validate the exact product universe.** IBKR's general API documentation does not establish that its prediction-market contracts are discoverable through the relevant API endpoints, nor that depth is available for them. This must be tested using a permitted account with the required data entitlements.
4. **Keep execution out of scope.** If a later manual order flow is considered, it remains behind EdgeFinder's existing server-side kill switch and dry-run protections. No poller, watcher, or scheduler may execute orders.

## Recommended proof-of-access checklist

1. Confirm the account is IBKR Pro, funded, 2FA-enabled, and has the appropriate market-data subscription.
2. Install and run Client Portal Gateway locally; authenticate in its local browser UI.
3. Verify brokerage-session state and identify a concrete IBKR prediction-market contract.
4. Fetch a live quote; attempt market depth; record the entitlement/error response and contract identifier.
5. Check whether the contract can be mapped to an equivalent Kalshi/Polymarket market. If there is no overlap or no usable depth, stop: no adapter is justified.
6. Only after steps 1–5 pass, create a narrow **read-only** adapter ticket. Do not add order placement.

## Sweden-specific finding

The official API documentation reviewed explicitly documents a Canadian restriction for programmatic orders of Canadian products. It did **not** provide a Sweden-specific API restriction in the material reviewed. That is not a clearance: account eligibility, product availability, and data entitlements must be confirmed in the actual Swedish IBKR account.

## Primary sources

- [Client Portal Web API documentation](https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/) — account requirements, CP Gateway, authentication, brokerage sessions.
- [TWS API documentation](https://www.interactivebrokers.com/campus/ibkr-api-page/twsapi-doc/) — API architecture, prerequisites, local TWS/IB Gateway requirement.
- [IBKR API getting started](https://www.interactivebrokers.com/campus/ibkr-api-page/getting-started/) — API options and intended use.
