import { describe, expect, it } from "vitest";
import { derivePositionRisk } from "./position-risk";

const now = Date.parse("2026-08-08T12:00:00Z");

describe("derivePositionRisk", () => {
  it("labels paired positions and computes fee-aware exit value and conservative exposure", () => {
    const risk = derivePositionRisk({
      kalshi: { currentValue: 60, exitFees: 1 },
      polymarket: { currentValue: 55, exitFees: 2, endDate: "2026-08-10T12:00:00Z" },
      breakdown: { totalNetPnl: 4 },
    }, now);
    expect(risk).toMatchObject({ pairedState: "paired", netExitValue: 112, oneLegExposure: 60, exitLiquidityRisk: "unverified" });
    expect(risk.attentionReasons).toEqual(["Exit depth unverified"]);
  });

  it("prioritizes one-legged, negative, and approaching-expiry risk", () => {
    const risk = derivePositionRisk({
      kalshi: null,
      polymarket: { currentValue: 40, exitFees: 0.5, endDate: "2026-08-08T18:00:00Z" },
      breakdown: { totalNetPnl: -2 },
    }, now);
    expect(risk.pairedState).toBe("unpaired");
    expect(risk.attentionReasons).toEqual([
      "One-legged position",
      "Negative net P&L after exit fees",
      "Expires within 24 hours",
      "Exit depth unverified",
    ]);
  });
});
