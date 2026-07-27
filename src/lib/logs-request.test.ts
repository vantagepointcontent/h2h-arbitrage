import { describe, expect, it } from "vitest";
import { parseLogLimit, parseOptionalFiniteNumber } from "./logs-request";

describe("parseLogLimit", () => {
  it("uses the safe default for absent or non-finite input", () => {
    expect(parseLogLimit(null)).toBe(100);
    expect(parseLogLimit("NaN")).toBe(100);
    expect(parseLogLimit("Infinity")).toBe(100);
  });

  it("bounds and integer-normalizes valid input", () => {
    expect(parseLogLimit("12.9")).toBe(12);
    expect(parseLogLimit("0")).toBe(1);
    expect(parseLogLimit("900")).toBe(500);
  });
});

describe("parseOptionalFiniteNumber", () => {
  it("accepts finite numeric filters", () => {
    expect(parseOptionalFiniteNumber("3.25")).toBe(3.25);
    expect(parseOptionalFiniteNumber("-1")).toBe(-1);
  });

  it("treats absent, blank, and non-finite filters as absent", () => {
    for (const value of [null, "", "  ", "NaN", "Infinity", "-Infinity", "not-a-number"]) {
      expect(parseOptionalFiniteNumber(value)).toBeUndefined();
    }
  });
});
