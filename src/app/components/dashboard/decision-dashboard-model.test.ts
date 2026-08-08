import { describe, expect, it } from "vitest";
import { buildAttentionQueue, summarizePortfolio } from "./decision-dashboard-model";

describe("decision dashboard model", () => {
  it("ranks unhedged and one-legged risk ahead of platform warnings", () => {
    const queue = buildAttentionQueue(
      [{ id: "p1", marketTitle: "Election", pairedState: "unpaired", attentionReasons: ["One-legged position", "Exit depth unverified"] }],
      [{ id: 4, marketTitle: "Fed", success: false, result: { unhedged: true } }],
      { kalshi: "Credentials unavailable" },
    );
    expect(queue.map(item => item.title)).toEqual(["One-legged position", "Unhedged execution", "kalshi position feed unavailable"]);
    expect(queue.every(item => item.title !== "Exit depth unverified")).toBe(true);
  });

  it("summarizes fee-aware portfolio totals", () => {
    expect(summarizePortfolio([
      { id: "a", marketTitle: "A", pairedState: "paired", totalCost: 100, oneLegExposure: 55, breakdown: { totalNetPnl: 3, totalFees: 2 } },
      { id: "b", marketTitle: "B", pairedState: "unpaired", totalCost: 40, oneLegExposure: 40, breakdown: { totalNetPnl: -1, totalFees: 1 } },
    ])).toEqual({ netPnl: 2, fees: 3, capitalDeployed: 140, netExposure: 95, paired: 1 });
  });
});
