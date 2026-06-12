import { describe, it, expect } from "vitest";
import {
  calculateArbitrageMax,
  computeApy,
  matchOutcomes,
  parseDepth,
} from "../src/lib/matcher";

const K_KALSHI = {
  ticker: "KX-TEST-1",
  event_ticker: "KX-TEST-1",
  title: "Test Market",
  yesBid: 0.44,
  yesAsk: 0.45,
  noBid: 0.54,
  noAsk: 0.55,
  lastPrice: 0.50,
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
  yesBid: 0.55,
  yesAsk: 0.60,
  noBid: 0.38,
  noAsk: 0.40,
  lastPrice: 0.55,
  yes_bid_dollars: "0.55",
  yes_ask_dollars: "0.60",
  no_bid_dollars: "0.38",
  no_ask_dollars: "0.40",
  last_price_dollars: "0.55",
  volume_24h_fp: "500",
};

const PM_CHEAP_YES = {
  id: "abc-1",
  conditionId: "abc-1",
  question: "Cheap YES",
  groupItemTitle: null,
  outcomes: ["Yes", "No"],
  prices: [0.35, 0.65],
  bestBid: 0.34,
  bestAsk: 0.36,
  lastTradePrice: 0.35,
};

const PM_CHEAP_NO = {
  id: "abc-2",
  conditionId: "abc-2",
  question: "Cheap NO",
  groupItemTitle: null,
  outcomes: ["Yes", "No"],
  prices: [0.50, 0.50],
  bestBid: 0.49,
  bestAsk: 0.51,
  lastTradePrice: 0.50,
};

const PM_NEUTRAL = {
  id: "abc-3",
  conditionId: "abc-3",
  question: "Neutral",
  groupItemTitle: null,
  outcomes: ["Yes", "No"],
  prices: [0.50, 0.50],
  bestBid: 0.48,
  bestAsk: 0.52,
  lastTradePrice: 0.50,
};

describe("calculateArbitrageMax", () => {
  it("calculates correct profit for simple arb (Buy YES Kalshi + NO PM)", () => {
    const result = calculateArbitrageMax(K_KALSHI, PM_CHEAP_NO, 0, 0, 0, 0);
    expect(result.strategy).toBe("Buy YES Kalshi + NO PM");
    expect(result.roiPct).toBeGreaterThan(0);
    expect(result.expectedProfit).toBeGreaterThan(0);
  });

  it("calculates correct profit for reversed arb (Buy YES PM + NO Kalshi)", () => {
    const result = calculateArbitrageMax(K_KALSHI_EXPENSIVE, PM_CHEAP_YES, 0, 0, 0, 0);
    expect(result.strategy).toBe("Buy YES PM + NO Kalshi");
    expect(result.roiPct).toBeGreaterThan(20);
    expect(result.expectedProfit).toBeGreaterThan(200);
  });

  it("returns No arb when prices sum to >= 1", () => {
    const result = calculateArbitrageMax(K_KALSHI_EXPENSIVE, PM_NEUTRAL, 0, 0, 0, 0);
    expect(result.strategy).toBe("No arb");
    expect(result.expectedProfit).toBe(0);
    expect(result.roiPct).toBe(0);
  });

  it("respects depth limits and produces finite profit", () => {
    const result = calculateArbitrageMax(K_KALSHI, PM_CHEAP_NO, 1000, 0, 5000, 0);
    expect(result.strategy).toBe("Buy YES Kalshi + NO PM");
    expect(result.maxCapital).toBeGreaterThan(0);
    expect(result.maxCapital).toBeLessThan(Infinity);
    expect(result.expectedProfit).toBeGreaterThan(0);
    expect(result.expectedProfit).toBeLessThan(Infinity);
  });

  it("profit = capital × ROI (unit test for reported bug)", () => {
    const k = { ...K_KALSHI, yesAsk: 0.85, noAsk: 0.15 };
    const pm = { ...PM_CHEAP_NO, yesPrice: 0.90, noPrice: 0.11, bestAsk: 0.91 };
    const result = calculateArbitrageMax(k, pm, 40000, 0, 5000, 0);
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
  it("matches identical artist names", () => {
    const kalshi = [{
      ticker: "KX-TEST-1",
      event_ticker: "KX-TEST-1",
      title: "Trump",
      yesBid: 0.44,
      yesAsk: 0.45,
      noBid: 0.54,
      noAsk: 0.55,
      lastPrice: 0.50,
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
      groupItemTitle: null,
      outcomes: ["Yes", "No"],
      prices: [0.55, 0.45],
      bestBid: 0.54,
      bestAsk: 0.56,
      lastTradePrice: 0.55,
    }];
    const result = matchOutcomes(kalshi, pm, "Trump", 100);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const trump = result.find(r => r.artist.includes("Trump"));
    expect(trump).toBeDefined();
    expect(trump?.kalshi).toBeDefined();
    expect(trump?.polymarket).toBeDefined();
  });

  it("includes unmatched outcomes separately", () => {
    const kalshi = [{
      ticker: "KX-TEST-1",
      event_ticker: "KX-TEST-1",
      title: "Trump",
      yesBid: 0.44,
      yesAsk: 0.45,
      noBid: 0.54,
      noAsk: 0.55,
      lastPrice: 0.50,
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
      question: "Biden",
      groupItemTitle: null,
      outcomes: ["Yes", "No"],
      prices: [0.55, 0.45],
      bestBid: 0.54,
      bestAsk: 0.56,
      lastTradePrice: 0.55,
    }];
    const result = matchOutcomes(kalshi, pm, "Election", 100);
    expect(result.length).toBe(2);
    const trump = result.find(r => r.artist.includes("Trump"));
    expect(trump?.kalshi).toBeDefined();
    expect(trump?.polymarket).toBeNull();
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
});
