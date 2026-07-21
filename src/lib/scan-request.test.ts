import { describe, expect, it } from "vitest";
import { MAX_SCAN_CAPITAL, MIN_SCAN_CAPITAL, parseScanCapital } from "./scan-request";

describe("parseScanCapital", () => {
  it("uses the safe default when omitted", () => {
    expect(parseScanCapital(undefined)).toBe(1000);
  });

  it("accepts finite capital within the supported range", () => {
    expect(parseScanCapital(MIN_SCAN_CAPITAL)).toBe(MIN_SCAN_CAPITAL);
    expect(parseScanCapital(2500.5)).toBe(2500.5);
    expect(parseScanCapital(MAX_SCAN_CAPITAL)).toBe(MAX_SCAN_CAPITAL);
  });

  it("rejects non-numeric, non-finite, and out-of-range values", () => {
    for (const value of ["1000", null, NaN, Infinity, -1, 0, MAX_SCAN_CAPITAL + 1]) {
      expect(parseScanCapital(value)).toBeNull();
    }
  });
});
