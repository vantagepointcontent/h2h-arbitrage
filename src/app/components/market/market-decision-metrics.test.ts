import { describe, expect, it } from "vitest";
import { selectMarketDecisionMetrics } from "./market-decision-metrics";

describe("market decision metrics", () => {
  it("uses fee-aware net profit and executable capacity", () => {
    expect(selectMarketDecisionMetrics([
      { arbitrage: { roiPct: 9, expectedProfit: 90, fees: { worstCaseNetProfit: -2 }, maxFillableStake: 900 } },
      { arbitrage: { roiPct: 2.5, expectedProfit: 30, fees: { worstCaseNetProfit: 22 }, maxFillableStake: 400 } },
    ])).toEqual({ bestNetRoi: 2.5, bestNetProfit: 22, maxExecutableStake: 400 });
  });

  it("falls back to leg stake totals for older scans", () => {
    expect(selectMarketDecisionMetrics([{ arbitrage: { roiPct: 1, expectedProfit: 5, kalshiStake: 40, pmStake: 60 } }]).maxExecutableStake).toBe(100);
  });
});
