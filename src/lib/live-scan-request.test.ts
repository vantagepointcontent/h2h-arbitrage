import { describe, expect, it } from "vitest";
import { MAX_LIVE_SCAN_CAPITAL, MIN_LIVE_SCAN_CAPITAL, parseLiveScanCapital } from "./live-scan-request";

describe("parseLiveScanCapital", () => {
  it("uses the live-scan default when the query parameter is absent", () => {
    expect(parseLiveScanCapital(null)).toBe(10);
  });

  it("accepts finite capital within the supported range", () => {
    expect(parseLiveScanCapital(String(MIN_LIVE_SCAN_CAPITAL))).toBe(MIN_LIVE_SCAN_CAPITAL);
    expect(parseLiveScanCapital("2500.5")).toBe(2500.5);
    expect(parseLiveScanCapital(String(MAX_LIVE_SCAN_CAPITAL))).toBe(MAX_LIVE_SCAN_CAPITAL);
  });

  it("rejects blank, non-finite, and out-of-range query values", () => {
    for (const value of ["", " ", "not-a-number", "Infinity", "-1", "0", String(MAX_LIVE_SCAN_CAPITAL + 1)]) {
      expect(parseLiveScanCapital(value)).toBeNull();
    }
  });
});
