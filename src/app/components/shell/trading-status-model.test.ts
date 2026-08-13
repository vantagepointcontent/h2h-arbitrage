import { describe, expect, it } from "vitest";
import { buildTradingStatus } from "./trading-status-model";

const base = {
  now: Date.parse("2026-08-08T10:00:10Z"),
  watcher: { status: "ok", lastTickAt: "2026-08-08T10:00:05Z", kalshiConnected: true, pmConnections: "1/1" },
  execution: { mode: "paper", policy: "manual-only", credentials: { kalshi: { ready: true }, polymarket: { ready: true } } },
  positions: { positions: [] },
  executions: { executions: [] },
};

describe("trading status model", () => {
  it("only reports live inside the documented freshness threshold", () => {
    expect(buildTradingStatus(base)[0]).toMatchObject({ value: "Live · 5s old", tone: "positive" });
    expect(buildTradingStatus({ ...base, now: Date.parse("2026-08-08T10:00:40Z") })[0]).toMatchObject({ value: "Polling · 35s old", tone: "warning" });
    expect(buildTradingStatus({ ...base, now: Date.parse("2026-08-08T10:01:10Z") })[0]).toMatchObject({ value: "Stale · 65s old", tone: "critical" });
  });

  it("distinguishes platform health and keeps manual-only execution explicit", () => {
    const items = buildTradingStatus({ ...base, watcher: { ...base.watcher, kalshiConnected: false, pmConnections: "0/1" }, execution: { ...base.execution, mode: "live-gated", credentials: { kalshi: { ready: true }, polymarket: { ready: false } } } });
    expect(items.find((item) => item.id === "kalshi")?.value).toBe("Delayed");
    expect(items.find((item) => item.id === "polymarket")?.value).toBe("Credentials unavailable");
    expect(items.find((item) => item.id === "execution")?.value).toBe("Manual only · Kill switch on");
  });

  it("makes unhedged exposure persistent and critical", () => {
    const items = buildTradingStatus({ ...base, executions: { executions: [{ result: { unhedged: true, netExposure: 42.5 } }] } });
    expect(items.find((item) => item.id === "risk")).toMatchObject({ value: "1 unhedged · $42.50", tone: "critical" });
  });

  it("discloses BotTrader open exposure excluded from executable valuation", () => {
    const items = buildTradingStatus({
      ...base,
      botAnalytics: { analytics: { openPositions: { count: 5 }, performance: { capital: { excludedOpenCostCents: 287 }, valuation: { stale: 1, unavailable: 2 } } } },
    });
    expect(items.find((item) => item.id === "risk")).toMatchObject({ value: "3 unvalued · $2.87", tone: "warning" });
  });

  it("fails closed when status endpoints are unavailable", () => {
    const items = buildTradingStatus({ failed: ["watcher", "execution"] });
    expect(items.find((item) => item.id === "feed")?.tone).toBe("critical");
    expect(items.find((item) => item.id === "execution")?.value).toBe("Blocked");
  });
});
