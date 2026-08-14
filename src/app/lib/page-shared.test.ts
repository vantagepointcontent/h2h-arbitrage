import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKET_EXPIRY_FILTER,
  DEFAULT_SHOW_ARB_ONLY,
  formatPercent,
  summarizeScanForSidebar,
  getCanonicalMatchState,
  formatCanonicalMatchState,
  getMarketApySummary,
  mergeSavedMarketMatchRefresh,
  markSavedMarketMatchRefreshing,
  type SavedMarket,
  type UnifiedOutcome,
} from "./page-shared";

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

describe("saved-market visibility defaults", () => {
  it("shows all non-expired markets instead of starting behind restrictive filters", () => {
    expect(DEFAULT_MARKET_EXPIRY_FILTER).toBe("all");
    expect(DEFAULT_SHOW_ARB_ONLY).toBe(false);
  });
});

describe("BUG-133 canonical saved-market match summaries", () => {
  const market = (lastScanResult: SavedMarket["lastScanResult"], liveResult?: SavedMarket["liveResult"]): SavedMarket => ({
    id: "tx-07",
    kalshiUrl: "https://kalshi.com/markets/kxhouserace/kxhouserace-tx07-26",
    polymarketUrl: "https://polymarket.com/market/tx-07",
    eventTitle: "TX-07 House Election Winner",
    createdAt: "2026-07-02T13:33:16.000Z",
    lastScanResult,
    liveResult,
  });

  it("backfills a legacy TX-07 summary from its authoritative matchedCount when pair ids were not persisted", () => {
    const saved = market({
      bestRoiPct: 0, bestProfit: 0, strategy: "No arb", outcomeCount: 8,
      matchedCount: 2, matchedPairs: [], kalshiCount: 2, pmCount: 8,
      scannedAt: "2026-08-12T19:49:14.096Z", allArbs: [],
    });

    expect(getCanonicalMatchState(saved)).toEqual({ status: "matched", count: 2, error: undefined });
    expect(formatCanonicalMatchState(saved)).toBe("2 matched");
  });

  it("retains the latest confirmed count while a newer refresh is unavailable", () => {
    const saved = market({
      bestRoiPct: 0, bestProfit: 0, strategy: "No arb", outcomeCount: 2,
      matchedCount: 2, kalshiCount: 2, pmCount: 2,
      scannedAt: "2026-08-12T19:49:14.096Z", matchStatus: "matched", allArbs: [],
    }, {
      bestRoiPct: 0, bestProfit: 0, strategy: "No arb", matchedCount: 0,
      scannedAt: "2026-08-12T19:50:14.096Z", matchStatus: "unavailable",
      matchError: "Polymarket unavailable", allArbs: [],
    });
    const state = getCanonicalMatchState(saved);

    expect(state).toEqual({ status: "unavailable", count: 2, error: "Polymarket unavailable" });
    expect(formatCanonicalMatchState(saved)).toBe("2 matched · Unavailable: Polymarket unavailable");
  });

  it("ignores an older live watcher summary when the persisted scan is newer", () => {
    const state = getCanonicalMatchState(market({
      bestRoiPct: 0, bestProfit: 0, strategy: "No arb", outcomeCount: 2,
      matchedCount: 2, kalshiCount: 2, pmCount: 2,
      scannedAt: "2026-08-12T19:50:14.096Z", matchStatus: "matched", allArbs: [],
    }, {
      bestRoiPct: 0, bestProfit: 0, strategy: "No arb", matchedCount: 0,
      scannedAt: "2026-08-12T19:49:14.096Z", matchStatus: "confirmed_zero", allArbs: [],
    }));

    expect(state).toMatchObject({ status: "matched", count: 2 });
  });

  it("uses versioned canonical pair ids over a stale denormalized count after deletion", () => {
    const state = getCanonicalMatchState(market({
      bestRoiPct: 0, bestProfit: 0, strategy: "No arb", outcomeCount: 1,
      matchedCount: 2, kalshiCount: 2, pmCount: 2,
      scannedAt: "2026-08-12T19:50:14.096Z", matchStatus: "matched",
      matchedPairs: [{ artist: "Democratic", kalshiTicker: "TX07-D", pmConditionId: "pm-d" }],
      allArbs: [],
    }));

    expect(state).toMatchObject({ status: "matched", count: 1 });
  });

  it("marks loading explicitly without clearing the latest confirmed pairs", () => {
    const refreshing = markSavedMarketMatchRefreshing(market({
      bestRoiPct: 0, bestProfit: 0, strategy: "No arb", outcomeCount: 2,
      matchedCount: 2, kalshiCount: 2, pmCount: 2,
      scannedAt: "2026-08-12T19:49:14.096Z", matchStatus: "matched", allArbs: [],
    }));

    expect(getCanonicalMatchState(refreshing)).toMatchObject({ status: "refreshing", count: 2 });
  });

  it("marks a temporary failure unavailable while retaining confirmed pair ids", () => {
    const existing = market({
      bestRoiPct: 0, bestProfit: 0, strategy: "No arb", outcomeCount: 2,
      matchedCount: 2, kalshiCount: 2, pmCount: 2,
      scannedAt: "2026-08-12T19:49:14.096Z", matchStatus: "matched",
      matchedPairs: [
        { artist: "Democratic", kalshiTicker: "TX07-D", pmConditionId: "pm-d" },
        { artist: "Republican", kalshiTicker: "TX07-R", pmConditionId: "pm-r" },
      ], allArbs: [],
    });
    const merged = mergeSavedMarketMatchRefresh(existing, {
      matchStatus: "unavailable", matchError: "Polymarket unavailable", matchedCount: 0,
      matchedPairs: [], scannedAt: "2026-08-12T19:50:14.096Z",
    });

    expect(merged.lastScanResult).toMatchObject({
      matchStatus: "unavailable", matchedCount: 2,
      matchedPairs: existing.lastScanResult?.matchedPairs,
    });
  });
});

describe('outcome-contingent market APY summary', () => {
  it('preserves both venue scenarios and sorts by the explicit lower scenario', () => {
    const scenario = (winner: 'kalshi' | 'polymarket', apyPct: number, settlementAt: string) => ({
      label: winner === 'kalshi' ? 'scenario_a' as const : 'scenario_b' as const,
      winner, roiPct: 1, apyPct, settlementAt, daysToSettlement: 100,
      timingSource: winner === 'kalshi' ? 'kalshi.market.expected_expiration_time' as const : 'polymarket.event.endDate' as const,
      unavailableReason: null,
    });
    const marketWithScenarios = {
      id: 'market', kalshiUrl: '', polymarketUrl: '', eventTitle: 'Market', createdAt: '',
      lastScanResult: { bestRoiPct: 1, bestProfit: 1, strategy: 'Direct', outcomeCount: 1, matchedCount: 1, kalshiCount: 1, pmCount: 1, scannedAt: '2026-08-14T00:00:00Z', allArbs: [{
        artist: 'A', roiPct: 1, expectedProfit: 1, strategy: 'Direct', apyPct: null,
        outcomeApy: { observedAt: '2026-08-14T00:00:00Z', apyPct: null, unavailableReason: 'outcome_contingent' as const, scenarioA: scenario('kalshi', 2.5, '2027-01-01T00:00:00Z'), scenarioB: scenario('polymarket', 4.5, '2026-11-01T00:00:00Z'), kalshi: null, polymarket: null },
      }] },
    } as SavedMarket;
    expect(getMarketApySummary(marketWithScenarios)).toMatchObject({
      scalarApyPct: null,
      scenarioApyPct: { kalshi: 2.5, polymarket: 4.5 },
      sortApyPct: 2.5,
      unavailableReason: 'outcome_contingent',
    });
  });
});