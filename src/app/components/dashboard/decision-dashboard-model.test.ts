import { describe, expect, it } from "vitest";
import { buildAttentionQueue, summarizePortfolio } from "./decision-dashboard-model";

describe("decision dashboard model", () => {
  const nowMs = Date.parse("2026-08-08T12:00:00.000Z");

  it("ranks fresh unhedged and one-legged risk ahead of platform warnings", () => {
    const queue = buildAttentionQueue(
      [{ id: "p1", marketTitle: "Election", pairedState: "unpaired", attentionReasons: ["One-legged position", "Exit depth unverified"] }],
      [{ id: 4, marketTitle: "Fed", timestamp: "2026-08-08T11:00:00.000Z", success: false, result: { unhedged: true } }],
      { kalshi: "API unavailable" },
      { nowMs, credentialReady: { kalshi: true } },
    );
    expect(queue.map(item => item.title)).toEqual(["One-legged position", "Unhedged execution", "kalshi position feed unavailable"]);
    expect(queue.every(item => item.title !== "Exit depth unverified")).toBe(true);
  });

  it("filters execution failures older than 24 hours while retaining fresh real risk", () => {
    const queue = buildAttentionQueue([], [
      { id: 1, marketTitle: "Stale", timestamp: "2026-08-07T11:59:59.000Z", success: false },
      { id: 2, marketTitle: "Fresh", timestamp: "2026-08-08T11:30:00.000Z", success: false },
    ], {}, { nowMs });

    expect(queue).toHaveLength(1);
    expect(queue[0].detail).toBe("Fresh");
    expect(queue[0].severity).toBe(3);
  });

  it("downgrades missing credentials to information but keeps real API outages as warnings", () => {
    const queue = buildAttentionQueue([], [], {
      kalshi: "Credentials unavailable",
      polymarket: "Service timeout",
    }, {
      nowMs,
      credentialReady: { kalshi: false, polymarket: true },
    });

    expect(queue.find(item => item.id === "platform-kalshi")).toMatchObject({ severity: 1, title: "kalshi credentials not configured" });
    expect(queue.find(item => item.id === "platform-polymarket")).toMatchObject({ severity: 2, title: "polymarket position feed unavailable" });
  });

  it("summarizes fee-aware portfolio totals", () => {
    expect(summarizePortfolio([
      { id: "a", marketTitle: "A", pairedState: "paired", totalCost: 100, oneLegExposure: 55, breakdown: { totalNetPnl: 3, totalFees: 2 } },
      { id: "b", marketTitle: "B", pairedState: "unpaired", totalCost: 40, oneLegExposure: 40, breakdown: { totalNetPnl: -1, totalFees: 1 } },
    ])).toEqual({ netPnl: 2, fees: 3, capitalDeployed: 140, netExposure: 95, paired: 1 });
  });

  it("keeps portfolio P&L and fees unavailable when any position lacks authority", () => {
    expect(summarizePortfolio([
      { id: "a", marketTitle: "A", pairedState: "paired", totalCost: 100, breakdown: { totalNetPnl: 3, totalFees: 2 } },
      { id: "b", marketTitle: "B", pairedState: "paired", totalCost: 40, breakdown: { totalNetPnl: null, totalFees: null } },
    ])).toEqual({ netPnl: null, fees: null, capitalDeployed: 140, netExposure: 0, paired: 2 });
  });
});
