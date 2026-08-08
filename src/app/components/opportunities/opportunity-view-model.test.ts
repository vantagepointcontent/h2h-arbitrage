import { describe, expect, it } from "vitest";
import { buildOpportunityViewModel, filterOpportunities, rankOpportunities, type OpportunitySource } from "./opportunity-view-model";

const base: OpportunitySource = {
  artist: "Outcome A",
  kalshi: { ticker: "K-A", yesAsk: 0.42, noAsk: 0.59, yesAskDepth: "1000", noAskDepth: "1000" },
  polymarket: { conditionId: "PM-A", yesPrice: 0.43, noPrice: 0.58, askDepth: 1000, noAskDepth: 1000 },
  arbitrage: { strategy: "Buy YES Kalshi + NO PM", expectedProfit: 12, roiPct: 4, kalshiStake: 200, pmStake: 210, maxCapital: 410 },
};

const now = Date.parse("2026-08-08T09:00:00Z");

describe("OpportunityViewModel", () => {
  it("uses existing worst-case net profit without recalculating gross profit", () => {
    const model = buildOpportunityViewModel({
      ...base,
      arbitrage: { ...base.arbitrage, expectedProfit: 15, fees: { kalshiFee: 1, pmFee: 2, worstCaseNetProfit: 11 } },
    }, { scannedAt: "2026-08-08T08:59:30Z", now });

    expect(model.netProfit).toBe(11);
    expect(model.requiredCapital).toBe(410);
    expect(model.riskState).toBe("executable");
  });

  it("penalizes stale, thin, and blocked opportunities below executable net value", () => {
    const executable = buildOpportunityViewModel(base, { scannedAt: "2026-08-08T08:59:30Z", now });
    const stale = buildOpportunityViewModel(base, { scannedAt: "2026-08-08T08:00:00Z", now });
    const thin = buildOpportunityViewModel({ ...base, arbitrage: { ...base.arbitrage, maxCapital: 50 } }, { scannedAt: "2026-08-08T08:59:30Z", now });
    const blocked = buildOpportunityViewModel({ ...base, kalshi: null }, { scannedAt: "2026-08-08T08:59:30Z", now });

    expect(rankOpportunities([blocked, stale, thin, executable]).map((item) => item.riskState)).toEqual(["executable", "thin", "stale", "blocked"]);
  });

  it("supports saved queue views without dropping stable selection ids", () => {
    const durable = buildOpportunityViewModel({ ...base, persistence: "durable" }, { marketId: "m1", scannedAt: "2026-08-08T08:59:30Z", now });
    const needsMatch = buildOpportunityViewModel({ ...base, artist: "Outcome B", polymarket: null }, { marketId: "m1", scannedAt: "2026-08-08T08:59:30Z", now });

    expect(filterOpportunities([durable, needsMatch], "durable").map((item) => item.id)).toEqual([durable.id]);
    expect(filterOpportunities([durable, needsMatch], "needs-matching").map((item) => item.id)).toEqual([needsMatch.id]);
  });
});
