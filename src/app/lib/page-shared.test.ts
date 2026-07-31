import { describe, expect, it } from "vitest";
import { formatPercent, summarizeScanForSidebar, type UnifiedOutcome } from "./page-shared";

function outcome(roiPct: number, expectedProfit = 0.01, suspicious = false): UnifiedOutcome {
  return {
    artist: `Outcome ${roiPct}`,
    kalshi: null,
    polymarket: null,
    arbitrage: {
      strategy: "Buy YES Kalshi + NO PM",
      kalshiStake: 1,
      pmStake: 1,
      expectedProfit,
      roiPct,
      buyPlatform: null,
      buyPrice: 0,
      sellPlatform: null,
      sellPrice: 0,
      suspicious,
    },
  };
}

describe("BUG-033 sidebar ROI synchronization", () => {
  it("uses the current scan's best non-suspicious net ROI", () => {
    expect(summarizeScanForSidebar([outcome(0.04), outcome(0.03), outcome(8, 2, true)]))
      .toMatchObject({ bestRoiPct: 0.04, bestProfit: 0.01 });
  });

  it("formats a 0.04% maximum as 0.0% consistently", () => {
    const summary = summarizeScanForSidebar([outcome(0.04)]);
    expect(formatPercent(summary.bestRoiPct)).toBe("0.0%");
  });

  it("falls back to no arb when the scan has no trustworthy candidate", () => {
    expect(summarizeScanForSidebar([outcome(8, 2, true)])).toEqual({
      bestRoiPct: 0,
      bestProfit: 0,
      strategy: "No arb",
    });
  });
});