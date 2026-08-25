import { describe, expect, it } from "vitest";
import {
  applyDurableFullScanToSavedMarket,
  DEFAULT_MARKET_EXPIRY_FILTER,
  DEFAULT_SHOW_ARB_ONLY,
  formatPercent,
  summarizeScanForSidebar,
  getCanonicalMatchState,
  formatCanonicalMatchState,
  getMarketApySummary,
  compareSavedMarketApy,
  getQuickApyProvenance,
  mergeSavedMarketHydration,
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

  it.each([
    ['zero total stake', { kalshiStake: 0, pmStake: 0 }, 1.25],
    ['mismatched optional APY/TTE', { apyPct: 99, daysToExpiry: 999 }, 1.25],
  ])('derives canonical APY after a persisted full-scan refresh with a %s', (_label, override, expectedProfit) => {
    const scannedAt = '2026-08-13T19:59:00Z';
    const expiryAt = '2026-10-02T00:00:00.000Z';
    const daysToExpiry = (Date.parse(expiryAt) - Date.parse(scannedAt)) / 86_400_000;
    const roiPct = 2.5;
    const candidate = outcome(roiPct, 1.25);
    candidate.arbitrage = {
      ...candidate.arbitrage,
      arbType: 'direct',
      executionStatus: 'executable',
      apyPct: (Math.pow(1 + roiPct / 100, 365 / daysToExpiry) - 1) * 100,
      daysToExpiry,
      expiryAt,
      ...override,
    } as UnifiedOutcome['arbitrage'] & { arbType: 'direct' };
    const market: SavedMarket = {
      id: 'market-1', eventTitle: 'Market 1', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-13T18:00:00Z',
    };

    const updated = applyDurableFullScanToSavedMarket(market, {
      fullScanPersisted: true, publicationGeneration: 4,
      outcomes: [candidate], kalshiCount: 1, pmCount: 1, matchedCount: 1,
    }, scannedAt);

    expect(updated).toMatchObject({
      canonicalApyUnavailableReason: null,
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentProfit: expectedProfit,
      canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalCurrentDaysToExpiry: daysToExpiry,
      canonicalCurrentExpiryAt: expiryAt,
      canonicalApyRevision: 4,
      canonicalCurrentRevision: 4,
    });
    expect(updated.canonicalApyPct).toBeCloseTo((Math.pow(1 + roiPct / 100, 365 / daysToExpiry) - 1) * 100, 12);
  });

  it('does not promote an explicitly non-executable candidate into current canonical financials', () => {
    const scannedAt = '2026-08-13T19:59:00Z';
    const expiryAt = '2026-10-02T00:00:00.000Z';
    const candidate = outcome(2.5, 1.25);
    candidate.arbitrage = {
      ...candidate.arbitrage,
      arbType: 'direct',
      executionStatus: 'non_executable',
      expiryAt,
    } as UnifiedOutcome['arbitrage'] & { arbType: 'direct' };
    const market: SavedMarket = {
      id: 'market-1', eventTitle: 'Market 1', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-13T18:00:00Z',
    };

    const updated = applyDurableFullScanToSavedMarket(market, {
      fullScanPersisted: true, publicationGeneration: 4,
      outcomes: [candidate], kalshiCount: 1, pmCount: 1, matchedCount: 1,
    }, scannedAt);
    expect(updated).toMatchObject({
      canonicalApyPct: null,
      canonicalApyUnavailableReason: 'no_canonical_arbitrage',
      canonicalCurrentRoiPct: null,
      canonicalCurrentProfit: null,
      canonicalCurrentStrategy: 'No arb',
      canonicalCurrentDaysToExpiry: null,
      canonicalCurrentExpiryAt: null,
    });
  });

  it('does not publish canonical APY after a persisted full scan with an unrecognized strategy', () => {
    const candidate = outcome(2.5, 1.25);
    candidate.arbitrage = {
      ...candidate.arbitrage,
      strategy: 'Buy MAYBE somewhere',
      arbType: 'direct',
      executionStatus: 'executable',
      expiryAt: '2026-10-02T00:00:00.000Z',
    } as UnifiedOutcome['arbitrage'] & { arbType: 'direct' };
    const market: SavedMarket = {
      id: 'market-1', eventTitle: 'Market 1', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-13T18:00:00Z',
    };

    expect(applyDurableFullScanToSavedMarket(market, {
      fullScanPersisted: true, publicationGeneration: 4,
      outcomes: [candidate], kalshiCount: 1, pmCount: 1, matchedCount: 1,
    }, '2026-08-13T19:59:00Z')).toMatchObject({
      canonicalApyPct: null,
      canonicalApyUnavailableReason: 'no_canonical_arbitrage',
      canonicalCurrentRoiPct: null,
      canonicalCurrentStrategy: 'No arb',
    });
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

describe('canonical market APY summary', () => {
  it('fails a partial zero-match quick refresh closed with explicit provenance', () => {
    const quick = getQuickApyProvenance({
      eventTitle: 'MD-01 House Election Winner',
      kalshiCount: 0,
      pmCount: 1,
      matchedCount: 0,
      refreshStatus: 'partial',
      _priceDataObservedAt: '2026-08-19T17:41:41.000Z',
      platformDiagnostics: {
        kalshi: { status: 'failed', count: 0, reason: 'Kalshi timed out' },
        polymarket: { status: 'fresh', count: 1 },
      },
      outcomes: [{
        ...outcome(0, 0),
        arbitrage: { ...outcome(0, 0).arbitrage, strategy: 'Unavailable — stale outcome data', apyPct: 0 },
        kalshiStale: true,
      }],
      unmatchedKalshi: [],
      unmatchedPolymarket: [],
    });

    expect(quick).toEqual({
      apyPct: null,
      observedAt: '2026-08-19T17:41:41.000Z',
      status: 'partial',
      reason: 'Kalshi timed out',
    });
  });

  it('uses persisted canonical APY while preserving both venue scenarios for detail', () => {
    const scenario = (winner: 'kalshi' | 'polymarket', apyPct: number, settlementAt: string) => ({
      label: winner === 'kalshi' ? 'scenario_a' as const : 'scenario_b' as const,
      winner, roiPct: 1, apyPct, settlementAt, daysToSettlement: 100,
      timingSource: winner === 'kalshi' ? 'kalshi.market.expected_expiration_time' as const : 'polymarket.event.endDate' as const,
      unavailableReason: null,
    });
    const marketWithScenarios = {
      id: 'market', kalshiUrl: '', polymarketUrl: '', eventTitle: 'Market', createdAt: '',
      canonicalApyPct: (Math.pow(1.01, 365 / 71) - 1) * 100, canonicalApyObservedAt: '2026-08-14T00:00:00Z',
      canonicalApySource: 'full_scan', canonicalApyRevision: 9,
      canonicalCurrentRoiPct: 1, canonicalCurrentProfit: 1, canonicalCurrentStrategy: 'Direct',
      canonicalCurrentDaysToExpiry: 71, canonicalCurrentExpiryAt: '2026-10-24T00:00:00Z', canonicalCurrentRevision: 9,
      lastScanResult: { bestRoiPct: 1, bestProfit: 1, strategy: 'Direct', outcomeCount: 1, matchedCount: 1, kalshiCount: 1, pmCount: 1, scannedAt: '2026-08-14T00:00:00Z', allArbs: [{
        artist: 'A', roiPct: 1, expectedProfit: 1, strategy: 'Direct', apyPct: 5.26, daysToExpiry: 71,
        outcomeApy: { observedAt: '2026-08-14T00:00:00Z', apyPct: null, unavailableReason: 'outcome_contingent' as const, scenarioA: scenario('kalshi', 2.5, '2027-01-01T00:00:00Z'), scenarioB: scenario('polymarket', 4.5, '2026-11-01T00:00:00Z'), kalshi: null, polymarket: null },
      }] },
    } as SavedMarket;
    expect(getMarketApySummary(marketWithScenarios)).toMatchObject({
      scalarApyPct: (Math.pow(1.01, 365 / 71) - 1) * 100,
      scenarioApyPct: { kalshi: 2.5, polymarket: 4.5 },
      sortApyPct: (Math.pow(1.01, 365 / 71) - 1) * 100,
      unavailableReason: null,
    });

    marketWithScenarios.canonicalApyPct = null;
    marketWithScenarios.canonicalApyUnavailableReason = 'missing_expiry';
    expect(getMarketApySummary(marketWithScenarios)).toMatchObject({
      scalarApyPct: null,
      scenarioApyPct: { kalshi: 2.5, polymarket: 4.5 },
      sortApyPct: null,
    });
  });

  it('keeps canonical APY available in compact rows when optional profit is unavailable', () => {
    const apyPct = (Math.pow(1.02, 365 / 100) - 1) * 100;
    const market = {
      id: 'roi-expiry-only', eventTitle: 'ROI and expiry only', kalshiUrl: '', polymarketUrl: '', createdAt: '',
      canonicalApyPct: apyPct,
      canonicalApyObservedAt: '2026-08-20T13:00:00.000Z',
      canonicalApySource: 'full_scan', canonicalApyRevision: 12,
      canonicalCurrentRoiPct: 2, canonicalCurrentProfit: null,
      canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalCurrentDaysToExpiry: 100,
      canonicalCurrentExpiryAt: '2026-11-28T13:00:00.000Z',
      canonicalCurrentRevision: 12,
    } as SavedMarket;

    expect(getMarketApySummary(market)).toMatchObject({
      scalarApyPct: apyPct,
      sortApyPct: apyPct,
      unavailableReason: null,
    });
  });

  it.each([
    ['NCAA Football: 2027 National Champion', null, 'No arb', null],
    ['MLB: Stolen Bases Leader', 1.388, 'Buy YES PM + NO Kalshi', null],
    ['Big Brother Season 28: 2nd Place', 1.275, 'Buy YES Kalshi + NO PM', 42.45],
  ])('rejects APY-only current projection for %s', (eventTitle, roiPct, strategy, daysToExpiry) => {
    const market = {
      id: eventTitle, eventTitle, kalshiUrl: '', polymarketUrl: '', createdAt: '',
      canonicalApyPct: 14,
      canonicalApyObservedAt: '2026-08-20T13:00:00.000Z',
      canonicalApySource: 'full_scan',
      canonicalApyRevision: 12,
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentStrategy: strategy,
      canonicalCurrentDaysToExpiry: daysToExpiry,
      canonicalCurrentExpiryAt: daysToExpiry == null ? null : '2026-10-01T00:00:00.000Z',
      canonicalCurrentRevision: strategy === 'No arb' ? 12 : 11,
    } as SavedMarket;

    expect(getMarketApySummary(market)).toMatchObject({
      scalarApyPct: null,
      sortApyPct: null,
      unavailableReason: 'current_metric_invariant_failed',
    });
  });

  it('sorts an APY-only row as unavailable even when its scalar is positive', () => {
    const validApy = (Math.pow(1.02, 365 / 100) - 1) * 100;
    const valid = {
      id: 'valid', eventTitle: 'Valid', kalshiUrl: '', polymarketUrl: '', createdAt: '',
      canonicalApyPct: validApy, canonicalApyObservedAt: '2026-08-20T13:00:00.000Z',
      canonicalApySource: 'full_scan', canonicalApyRevision: 3,
      canonicalCurrentRoiPct: 2, canonicalCurrentProfit: 1, canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalCurrentDaysToExpiry: 100, canonicalCurrentExpiryAt: '2026-11-28T13:00:00.000Z',
      canonicalCurrentRevision: 3,
    } as SavedMarket;
    const invalid = {
      ...valid, id: 'invalid', eventTitle: 'Invalid', canonicalApyPct: 99,
      canonicalCurrentRoiPct: null, canonicalCurrentStrategy: 'No arb',
      canonicalCurrentDaysToExpiry: null, canonicalCurrentExpiryAt: null,
    } as SavedMarket;

    expect([invalid, valid].sort((a, b) => compareSavedMarketApy(a, b, 'desc')).map((row) => row.id))
      .toEqual(['valid', 'invalid']);
  });

  it('sorts full precision deterministically with unavailable values last', () => {
    const saved = (id: string, eventTitle: string, canonicalApyPct: number | null): SavedMarket => {
      const roiPct = canonicalApyPct != null && canonicalApyPct > 0
        ? (Math.pow(1 + canonicalApyPct / 100, 100 / 365) - 1) * 100 : null;
      return {
        id, eventTitle, canonicalApyPct, kalshiUrl: '', polymarketUrl: '', createdAt: '',
        canonicalApySource: canonicalApyPct != null ? 'full_scan' : null, canonicalApyRevision: canonicalApyPct != null ? 1 : null,
        canonicalCurrentRoiPct: roiPct, canonicalCurrentProfit: roiPct == null ? null : 1,
        canonicalCurrentStrategy: roiPct == null ? 'No arb' : 'Buy YES Kalshi + NO PM',
        canonicalCurrentDaysToExpiry: roiPct == null ? null : 100,
        canonicalCurrentExpiryAt: roiPct == null ? null : '2026-11-28T00:00:00Z',
        canonicalCurrentRevision: canonicalApyPct != null ? 1 : null,
      };
    };
    const rows = [
      saved('null', 'Unavailable', null),
      saved('rounded-low', 'NCAA', 29.723101937298058),
      saved('negative', 'Negative', -1),
      saved('rounded-high', 'MD-01', 29.959508018509656),
      saved('zero', 'Zero', 0),
      saved('tie-b', 'B tie', 10),
      saved('tie-a', 'A tie', 10),
    ];
    expect([...rows].sort((a, b) => compareSavedMarketApy(a, b, 'desc')).map((row) => row.id)).toEqual([
      'rounded-high', 'rounded-low', 'tie-a', 'tie-b', 'negative', 'null', 'zero',
    ]);
    expect([...rows].sort((a, b) => compareSavedMarketApy(a, b, 'asc')).at(-1)?.id).toBe('zero');
  });

  it('fences delayed hydration from rolling back a newer canonical revision', () => {
    const base: SavedMarket = { id: 'm', eventTitle: 'Market', kalshiUrl: '', polymarketUrl: '', createdAt: '' };
    const current: SavedMarket = {
      ...base, canonicalApyPct: 30, canonicalApyObservedAt: '2026-08-19T14:30:00Z',
      canonicalApySource: 'full_scan', canonicalApyRevision: 12,
    };
    const delayed: SavedMarket = {
      ...base, eventTitle: 'Server title', canonicalApyPct: 29.7,
      canonicalApyObservedAt: '2026-08-19T14:29:00Z', canonicalApySource: 'full_scan', canonicalApyRevision: 11,
    };
    expect(mergeSavedMarketHydration(current, delayed)).toMatchObject({
      eventTitle: 'Server title', canonicalApyPct: 30, canonicalApyRevision: 12,
    });
  });

  it('uses publication revision before a conflicting observation timestamp', () => {
    const base: SavedMarket = { id: 'm', eventTitle: 'Market', kalshiUrl: '', polymarketUrl: '', createdAt: '' };
    const current: SavedMarket = {
      ...base, canonicalApyPct: 30, canonicalApyObservedAt: '2026-08-19T14:29:00Z',
      canonicalApySource: 'full_scan', canonicalApyRevision: 12,
    };
    const delayed: SavedMarket = {
      ...base, canonicalApyPct: 29.7, canonicalApyObservedAt: '2026-08-19T14:30:00Z',
      canonicalApySource: 'full_scan', canonicalApyRevision: 11,
    };

    expect(mergeSavedMarketHydration(current, delayed)).toMatchObject({
      canonicalApyPct: 30, canonicalApyObservedAt: '2026-08-19T14:29:00Z', canonicalApyRevision: 12,
    });
  });

  it('preserves a newer legacy recovered observation when its revision is null', () => {
    const base: SavedMarket = { id: 'm', eventTitle: 'Market', kalshiUrl: '', polymarketUrl: '', createdAt: '' };
    const recovered: SavedMarket = {
      ...base, canonicalApyPct: 30, canonicalApyObservedAt: '2026-08-19T14:30:00Z',
      canonicalApySource: 'full_scan', canonicalApyRevision: null,
    };
    const olderBoundRevision: SavedMarket = {
      ...base, canonicalApyPct: 29.7, canonicalApyObservedAt: '2026-08-19T14:29:00Z',
      canonicalApySource: 'full_scan', canonicalApyRevision: 11,
    };

    expect(mergeSavedMarketHydration(recovered, olderBoundRevision)).toMatchObject({
      canonicalApyPct: 30, canonicalApyObservedAt: '2026-08-19T14:30:00Z', canonicalApyRevision: null,
    });
  });
});