import { describe, expect, it } from "vitest";
import { parseLogLimit } from "./logs-request";

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
