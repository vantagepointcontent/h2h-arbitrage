import { describe, expect, it } from "vitest";
import {
  applyDurableFullScanToSavedMarket,
  DEFAULT_MARKET_EXPIRY_FILTER,
  DEFAULT_SHOW_ARB_ONLY,
  formatPercent,
  summarizeScanForSidebar,
  getCanonicalMatchState,
  formatCanonicalMatchState,
  getSavedMarketLastSuccessAt,
  getSavedMarketScheduleView,
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

describe("saved-market scheduler status", () => {
  const now = Date.parse("2026-08-13T20:00:00Z");

  it("keeps age tied to last successful full scan while surfacing failures", () => {
    expect(getSavedMarketScheduleView({
      lastAttemptAt: "2026-08-13T19:59:00Z",
      lastSuccessAt: "2026-08-13T18:00:00Z",
      nextDueAt: "2026-08-13T19:00:00Z",
      inProgress: false,
      failureReason: "Polymarket HTTP 503",
      retryCount: 2,
    }, "2026-08-13T18:00:00Z", now, 60 * 60_000)).toMatchObject({
      status: "failed", ageMs: 2 * 60 * 60_000, reason: "Polymarket HTTP 503",
    });
  });

  it("distinguishes fresh, due, scanning, overdue, and unavailable states", () => {
    expect(getSavedMarketScheduleView({ inProgress: true }, null, now, 60 * 60_000).status).toBe("scanning");
    expect(getSavedMarketScheduleView(null, "2026-08-13T18:00:00Z", now, 60 * 60_000).status).toBe("overdue");
    expect(getSavedMarketScheduleView({ nextDueAt: "2026-08-13T19:59:00Z" }, "2026-08-13T19:30:00Z", now, 60 * 60_000).status).toBe("due");
    expect(getSavedMarketScheduleView(null, "2026-08-13T19:30:00Z", now, 60 * 60_000).status).toBe("fresh");
    expect(getSavedMarketScheduleView(null, null, now, 60 * 60_000)).toMatchObject({
      status: "unavailable", reason: "No successful full scan is available yet.",
    });
  });

  it("separates rate limits from other exact failure reasons", () => {
    expect(getSavedMarketScheduleView({ failureReason: "HTTP 429" }, "2026-08-13T19:30:00Z", now).status).toBe("rate_limited");
    expect(getSavedMarketScheduleView({ failureReason: "Polymarket HTTP 503" }, "2026-08-13T19:30:00Z", now).status).toBe("failed");
  });

  it("publishes a durable manual full scan immediately and clears stale failure state", () => {
    const market: SavedMarket = {
      id: "market-1",
      eventTitle: "Market 1",
      kalshiUrl: "https://kalshi.com/markets/market-1",
      polymarketUrl: "https://polymarket.com/event/market-1",
      createdAt: "2026-08-13T18:00:00Z",
      lastScanResult: { bestRoiPct: 0, bestProfit: 0, strategy: "No arb", outcomeCount: 0, matchedCount: 0, kalshiCount: 0, pmCount: 0, scannedAt: "2026-08-13T18:00:00Z", allArbs: [] },
      scheduler: { lastSuccessAt: "2026-08-13T18:00:00Z", failureReason: "Kalshi HTTP 503", retryCount: 3, freshnessSlaMs: 60_000 },
    };
    const updated = applyDurableFullScanToSavedMarket(market, {
      fullScanPersisted: true,
      outcomes: [outcome(2.5, 1.25)],
      kalshiCount: 1,
      pmCount: 1,
      matchedCount: 1,
    }, "2026-08-13T19:59:00Z");

    expect(updated.scheduler).toMatchObject({
      lastSuccessAt: "2026-08-13T19:59:00Z",
      nextDueAt: "2026-08-13T20:00:00.000Z",
      inProgress: false,
      failureReason: null,
      retryCount: 0,
    });
    expect(updated.liveResult).toMatchObject({ bestRoiPct: 2.5, scannedAt: "2026-08-13T19:59:00Z" });
  });

  it("does not advance full-scan freshness when durable publication is unconfirmed", () => {
    const market: SavedMarket = {
      id: "market-1", eventTitle: "Market 1", kalshiUrl: "k", polymarketUrl: "p", createdAt: "2026-08-13T18:00:00Z",
      scheduler: { lastSuccessAt: "2026-08-13T18:00:00Z", failureReason: "publication failed", retryCount: 1, freshnessSlaMs: 60_000 },
    };
    const updated = applyDurableFullScanToSavedMarket(market, {
      fullScanPersisted: false, outcomes: [outcome(2.5)], kalshiCount: 1, pmCount: 1, matchedCount: 1,
    }, "2026-08-13T19:59:00Z");

    expect(updated.scheduler).toEqual(market.scheduler);
    expect(updated.liveResult).toMatchObject({ bestRoiPct: 2.5, scannedAt: "2026-08-13T19:59:00Z" });
  });

  it("never treats a watcher tick as the last successful full scan", () => {
    const market = {
      id: "market-1", eventTitle: "Market 1", kalshiUrl: "k", polymarketUrl: "p", createdAt: "2026-08-13T18:00:00Z",
      lastScanResult: { bestRoiPct: 0, bestProfit: 0, strategy: "No arb", outcomeCount: 0, matchedCount: 0, kalshiCount: 0, pmCount: 0, scannedAt: "2026-08-13T18:30:00Z", allArbs: [] },
      scheduler: { lastSuccessAt: "2026-08-13T19:00:00Z" },
      liveResult: { bestRoiPct: 1, bestProfit: 1, strategy: "arb", scannedAt: "2026-08-13T19:59:00Z" },
    } satisfies SavedMarket;

    expect(getSavedMarketLastSuccessAt(market)).toBe("2026-08-13T19:00:00Z");
  });

  it("does not treat unavailable or unclassified scan timestamps as successful", () => {
    const base = {
      id: "market-1", eventTitle: "Market 1", kalshiUrl: "k", polymarketUrl: "p", createdAt: "2026-08-13T18:00:00Z",
    };
    for (const matchStatus of ["unavailable", "refreshing", undefined] as const) {
      const market = {
        ...base,
        lastScanResult: {
          bestRoiPct: 0, bestProfit: 0, strategy: "No arb", outcomeCount: 0, matchedCount: 0,
          kalshiCount: 0, pmCount: 0, scannedAt: "2026-08-13T19:30:00Z", allArbs: [], matchStatus,
        },
      } satisfies SavedMarket;
      expect(getSavedMarketLastSuccessAt(market)).toBeNull();
    }
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