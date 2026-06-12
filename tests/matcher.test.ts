import { describe, it, expect } from "vitest";
import {
  calculateArbitrageMax,
  computeApy,
  matchOutcomes,
  parseDepth,
} from "../src/lib/matcher";

// Mock objects must match the exact interface expected by the functions
const K_KALSHI = {
  ticker: "KX-TEST-1",
  event_ticker: "KX-TEST-1",
  title: "Test Market",
  yes_bid_dollars: "0.44",
  yes_ask_dollars: "0.45",
  no_bid_dollars: "0.54",
  no_ask_dollars: "0.55",
  last_price_dollars: "0.50",
  volume_24h_fp: "1000",
};

const K_KALSHI_EXPENSIVE = {
  ticker: "KX-TEST-2",
  event_ticker: "KX-TEST-2",
  title: "Expensive Market",
  yes_bid_dollars: "0.55",
  yes_ask_dollars: "0.60",
  no_bid_dollars: "0.38",
  no_ask_dollars: "0.40",
  last_price_dollars: "0.55",
  volume_24h_fp: "500",
};

const K_KALSHI_NO_ARB = {
  ticker: "KX-TEST-3",
  event_ticker: "KX-TEST-3",
  title: "No Arb Market",
  yes_bid_dollars: "0.55",
  yes_ask_dollars: "0.60",
  no_bid_dollars: "0.40",
  no_ask_dollars: "0.42",
  last_price_dollars: "0.58",
  volume_24h_fp: "200",
};

// PM shape as returned by buildPmArbShape
const PM_CHEAP_NO = {
  marketId: "m2",
  conditionId: "abc-2",
  yesPrice: 0.50,
  noPrice: 0.50,
  bestBid: 0.49,
  bestAsk: 0.51,
  lastTradePrice: 0.50,
};

const PM_NEUTRAL = {
  marketId: "m3",
  conditionId: "abc-3",
  yesPrice: 0.50,
  noPrice: 0.50,
  bestBid: 0.48,
  bestAsk: 0.52,
  lastTradePrice: 0.50,
};

const PM_CHEAP_YES = {
  marketId: "m1",
  conditionId: "abc-1",
  yesPrice: 0.35,
  noPrice: 0.65,
  bestBid: 0.34,
  bestAsk: 0.36,
  lastTradePrice: 0.35,
};

describe("calculateArbitrageMax", () => {
  it("finds arb when sum < 1 (Buy YES Kalshi + NO PM)", () => {
    // kYes=0.45 + pNo=0.50 = 0.95 < 1 → arb exists
    const kShape = {
      ticker: "KX-TEST",
      yesBid: 0.44, yesAsk: 0.45,
      noBid: 0.54, noAsk: 0.55,
      lastPrice: 0.50,
    };
    const result = calculateArbitrageMax(kShape, PM_CHEAP_NO, 0, 0, 0, 0);
    expect(result.strategy).toBe("Buy YES Kalshi + NO PM");
    expect(result.roiPct).toBeGreaterThan(0);
    expect(result.expectedProfit).toBeGreaterThan(0);
  });

  it("finds reversed arb (Buy YES PM + NO Kalshi)", () => {
    // pYes=0.36 + kNo=0.40 = 0.76 < 1 → arb exists
    const kShape = {
      ticker: "KX-TEST",
      yesBid: 0.60, yesAsk: 0.60,
      noBid: 0.38, noAsk: 0.40,
      lastPrice: 0.58,
    };
    const result = calculateArbitrageMax(kShape, PM_CHEAP_YES, 0, 0, 0, 0);
    expect(result.strategy).toBe("Buy YES PM + NO Kalshi");
    expect(result.roiPct).toBeGreaterThan(20);
    expect(result.expectedProfit).toBeGreaterThan(200);
  });

  it("returns No arb when prices sum to >= 1", () => {
    // kYes=0.55 + pNo=0.45 = 1.00 → not < 1
    // pYes=0.55 + kNo=0.45 = 1.00 → not < 1
    const kShape = {
      ticker: "KX-TEST",
      yesBid: 0.54, yesAsk: 0.55,
      noBid: 0.44, noAsk: 0.45,
      lastPrice: 0.55,
    };
    const pmShape = {
      marketId: "m3",
      conditionId: "abc-3",
      yesPrice: 0.55,
      noPrice: 0.45,
      bestBid: 0.54,
      bestAsk: 0.56,
      lastTradePrice: 0.55,
    };
    const result = calculateArbitrageMax(kShape, pmShape, 0, 0, 0, 0);
    expect(result.strategy).toBe("No arb");
    expect(result.expectedProfit).toBe(0);
    expect(result.roiPct).toBe(0);
  });

  it("respects depth limits and produces finite profit", () => {
    const kShape = {
      ticker: "KX-TEST",
      yesBid: 0.44, yesAsk: 0.45,
      noBid: 0.54, noAsk: 0.55,
      lastPrice: 0.50,
    };
    const result = calculateArbitrageMax(kShape, PM_CHEAP_NO, 1000, 0, 5000, 0);
    expect(result.strategy).toBe("Buy YES Kalshi + NO PM");
    expect(result.maxCapital).toBeGreaterThan(0);
    expect(result.maxCapital).toBeLessThan(Infinity);
    expect(result.expectedProfit).toBeGreaterThan(0);
    expect(result.expectedProfit).toBeLessThan(Infinity);
  });

  it("profit = capital × ROI (unit test for reported Mercedes bug)", () => {
    // Mercedes: kYes=0.85, pNo=0.11 → ROI=4%
    const kShape = {
      ticker: "KX-MERCEDES",
      yesBid: 0.84, yesAsk: 0.85,
      noBid: 0.14, noAsk: 0.15,
      lastPrice: 0.85,
    };
    const pmShape = {
      marketId: "m-merc",
      conditionId: "abc-merc",
      yesPrice: 0.90,
      noPrice: 0.11,
      bestBid: 0.89,
      bestAsk: 0.91,
      lastTradePrice: 0.90,
    };
    const result = calculateArbitrageMax(kShape, pmShape, 40000, 0, 5000, 0);
    expect(result.strategy).toBe("Buy YES Kalshi + NO PM");
    expect(result.roiPct).toBeCloseTo(4.0, 1); // 1 - (0.85 + 0.11) = 0.04 → 4%
    expect(result.expectedProfit).toBeCloseTo(result.maxCapital * 0.04, 1);
  });
});

describe("computeApy", () => {
  it("returns 0 for null expiry", () => {
    expect(computeApy(10, null)).toBe(0);
  });

  it("annualises ROI correctly for 30 days", () => {
    const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeApy(10, expiry)).toBeCloseTo(10 * (365 / 30), 0);
  });

  it("returns 0 for expired markets", () => {
    const expiry = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeApy(10, expiry)).toBe(0);
  });
});

describe("matchOutcomes", () => {
  it("skips binary PM markets without groupItemTitle (existing behavior)", () => {
    const kalshi = [{
      ticker: "KX-TEST-1",
      event_ticker: "KX-TEST-1",
      title: "Trump",
      yes_bid_dollars: "0.44",
      yes_ask_dollars: "0.45",
      no_bid_dollars: "0.54",
      no_ask_dollars: "0.55",
      last_price_dollars: "0.50",
      volume_24h_fp: "1000",
    }];
    const pm = [{
      id: "m1",
      conditionId: "abc",
      question: "Trump",
      groupItemTitle: "Trump", // named binary → included
      outcomes: ["Yes", "No"],
      prices: [0.55, 0.45],
      bestBid: 0.54,
      bestAsk: 0.56,
      lastTradePrice: 0.55,
      slug: "trump",
      outcomePrices: [0.55, 0.45],
      active: true,
      closed: false,
    }];
    const result = matchOutcomes(kalshi, pm, "Trump", 100);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const trump = result.find(r => r.artist.includes("Trump"));
    expect(trump).toBeDefined();
    expect(trump?.kalshi).toBeDefined();
    expect(trump?.polymarket).toBeDefined();
  });
});

describe("parseDepth", () => {
  it("parses Infinity from string", () => {
    expect(parseDepth("Infinity")).toBe(Infinity);
  });

  it("parses numeric strings", () => {
    expect(parseDepth("5000")).toBe(5000);
  });

  it("parses null as 0", () => {
    expect(parseDepth(null)).toBe(0);
  });

  it("parses K/M/B suffixes", () => {
    expect(parseDepth("5K")).toBe(5000);
    expect(parseDepth("2.5M")).toBe(2_500_000);
  });
});
