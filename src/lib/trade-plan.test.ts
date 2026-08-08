import { describe, expect, it } from "vitest";
import { buildTradePlan } from "./trade-plan";

describe("buildTradePlan", () => {
  it("builds a fee-aware, non-executing plan for a supported arb", () => {
    const plan = buildTradePlan({ outcome: "Candidate A", strategy: "Buy YES Kalshi + NO PM", kalshiPrice: 0.42, polymarketPrice: 0.53, kalshiStake: 42, polymarketStake: 53, kalshiFee: 0.4, polymarketFee: 0.1, netProfit: 4.5 });
    expect(plan).toEqual(expect.objectContaining({ kalshiSide: "YES", polymarketSide: "NO", totalCapital: 95, totalFees: 0.5 }));
    expect(plan?.netRoiPct).toBeCloseTo(4.736842, 6);
  });

  it("rejects unsupported or non-executable inputs", () => {
    expect(buildTradePlan({ outcome: "A", strategy: "No arb", kalshiPrice: 0.4, polymarketPrice: 0.5, kalshiStake: 40, polymarketStake: 50, netProfit: 1 })).toBeNull();
    expect(buildTradePlan({ outcome: "A", strategy: "Buy YES PM + NO Kalshi", kalshiPrice: 0, polymarketPrice: 0.5, kalshiStake: 40, polymarketStake: 50, netProfit: 1 })).toBeNull();
  });
});
