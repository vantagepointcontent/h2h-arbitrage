import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatPercent,
  formatCurrency,
  getTotalProfit,
  formatProfitDisplay,
  formatExpiry,
  timeUntilExpiry,
} from "../src/app/page";

describe("formatPercent", () => {
  it("formats whole percentages (always one decimal)", () => {
    expect(formatPercent(5)).toBe("5.0%");
    expect(formatPercent(50)).toBe("50.0%");
    expect(formatPercent(100)).toBe("100.0%");
  });

  it("handles decimals with one fraction digit", () => {
    expect(formatPercent(5.5)).toBe("5.5%");
    expect(formatPercent(0.1)).toBe("0.1%");
  });

  it("handles zero and negatives", () => {
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(-10)).toBe("-10.0%");
  });
});

describe("formatCurrency", () => {
  it("formats whole dollars", () => {
    expect(formatCurrency(15)).toBe("$15.00");
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("formats decimal amounts", () => {
    expect(formatCurrency(15.5)).toBe("$15.50");
    expect(formatCurrency(1000)).toBe("$1,000.00");
  });

  it("handles negatives", () => {
    expect(formatCurrency(-10)).toBe("-$10.00");
  });
});

describe("getTotalProfit", () => {
  it("returns 0 for null/undefined", () => {
    expect(getTotalProfit(null)).toBe(0);
    expect(getTotalProfit(undefined)).toBe(0);
  });

  it("returns 0 for empty array", () => {
    expect(getTotalProfit([])).toBe(0);
  });

  it("sums only positive profits", () => {
    const arbs = [
      { expectedProfit: 10 },
      { expectedProfit: 20 },
      { expectedProfit: -5 },
      { expectedProfit: 0 },
    ];
    expect(getTotalProfit(arbs)).toBe(30);
  });

  it("ignores all-negative arrays", () => {
    const arbs = [
      { expectedProfit: -10 },
      { expectedProfit: -20 },
    ];
    expect(getTotalProfit(arbs)).toBe(0);
  });
});

describe("formatProfitDisplay", () => {
  it("returns empty string when bestProfit is 0", () => {
    expect(formatProfitDisplay(0)).toBe("");
  });

  it("shows only currency for single profitable position", () => {
    const arbs = [{ expectedProfit: 15 }];
    expect(formatProfitDisplay(15, arbs)).toBe("$15.00");
  });

  it("shows best + total for multiple profitable positions", () => {
    const arbs = [
      { expectedProfit: 15 },
      { expectedProfit: 9 },
    ];
    expect(formatProfitDisplay(15, arbs)).toBe("$15.00 ($24.00 total)");
  });

  it("counts only profitable items when mixing signs", () => {
    const arbs = [
      { expectedProfit: 15 },
      { expectedProfit: -5 },
    ];
    expect(formatProfitDisplay(15, arbs)).toBe("$15.00");
  });

  it("works with null allArbs", () => {
    expect(formatProfitDisplay(15, null)).toBe("$15.00");
  });
});

describe("formatExpiry", () => {
  it("formats valid ISO date", () => {
    const iso = "2024-12-25T00:00:00Z";
    expect(formatExpiry(iso)).toMatch(/\w+ \d{1,2}, 2024/);
  });

  it("returns em-dash for null/undefined/empty", () => {
    expect(formatExpiry(null)).toBe("\u2014");
    expect(formatExpiry(undefined)).toBe("\u2014");
    expect(formatExpiry("")).toBe("\u2014");
  });

  it("returns em-dash for invalid date string", () => {
    expect(formatExpiry("not-a-date")).toBe("\u2014");
  });
});

describe("timeUntilExpiry", () => {
  const FIXED_NOW = Date.parse("2024-12-01T00:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for null/undefined", () => {
    expect(timeUntilExpiry(null)).toBe("");
    expect(timeUntilExpiry(undefined)).toBe("");
  });

  it("returns 'Expired' for past dates", () => {
    const past = "2024-11-01T00:00:00Z";
    expect(timeUntilExpiry(past)).toBe("Expired");
  });

  it("returns days and hours for distant expiries", () => {
    // Dec 31, 2024 = 30 days from Dec 1 midnight
    const future = "2024-12-31T00:00:00Z";
    expect(timeUntilExpiry(future)).toBe("30d 0h");
  });

  it("returns only hours when less than a day away", () => {
    // Dec 1, 2024 05:00 = 5 hours away
    const soon = "2024-12-01T05:00:00Z";
    expect(timeUntilExpiry(soon)).toBe("5h");
  });

  it("handles same-day expiry with hours", () => {
    const today = "2024-12-01T12:30:00Z";
    expect(timeUntilExpiry(today)).toBe("12h");
  });
});
