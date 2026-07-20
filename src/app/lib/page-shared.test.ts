import { describe, it, expect } from "vitest";
import { formatPrice, formatCurrency, formatPercent } from "./page-shared";

describe("formatPrice", () => {
  it("shows 2 decimals for normal prices (>= 0.01)", () => {
    expect(formatPrice(0.50)).toBe("0.50");
    expect(formatPrice(0.95)).toBe("0.95");
    expect(formatPrice(0.01)).toBe("0.01");
    expect(formatPrice(0.99)).toBe("0.99");
  });

  it("shows 3 decimals for sub-cent prices (>= 0.001)", () => {
    expect(formatPrice(0.004)).toBe("0.004");
    expect(formatPrice(0.001)).toBe("0.001");
    expect(formatPrice(0.009)).toBe("0.009");
  });

  it("shows 4 decimals for very small prices (< 0.001)", () => {
    expect(formatPrice(0.0004)).toBe("0.0004");
    expect(formatPrice(0.0001)).toBe("0.0001");
    expect(formatPrice(0.00009)).toBe("0.0001");
  });

  it("returns dash for null/undefined", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(undefined)).toBe("—");
  });

  it("does NOT round 0.004 to 0.00 (the original bug)", () => {
    // This is the exact case Victor reported: $0.004 was showing as "0.00"
    const result = formatPrice(0.004);
    expect(result).not.toBe("0.00");
    expect(result).toBe("0.004");
  });
});

describe("formatCurrency (regression check)", () => {
  it("still formats normal dollar amounts correctly", () => {
    expect(formatCurrency(15)).toBe("$15.00");
    expect(formatCurrency(0)).toBe("$0.00");
    expect(formatCurrency(15.5)).toBe("$15.50");
    expect(formatCurrency(1000)).toBe("$1,000.00");
    expect(formatCurrency(-10)).toBe("-$10.00");
  });
});

describe("formatPercent (regression check)", () => {
  it("still formats percentages correctly", () => {
    expect(formatPercent(5)).toBe("5.0%");
    expect(formatPercent(50)).toBe("50.0%");
    expect(formatPercent(0)).toBe("0.0%");
  });
});