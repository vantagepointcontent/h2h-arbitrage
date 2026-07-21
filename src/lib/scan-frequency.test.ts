import { describe, expect, it } from "vitest";
import { DEFAULT_TIERS, parseScanConfigTiers } from "./scan-frequency";

describe("parseScanConfigTiers", () => {
  it("accepts the supported Hot/Warm/Cold tier structure", () => {
    expect(parseScanConfigTiers(DEFAULT_TIERS)).toEqual({ tiers: DEFAULT_TIERS });
  });

  it("rejects empty, unordered, and unsafe tier configurations", () => {
    expect(parseScanConfigTiers([])).toHaveProperty("error");
    expect(parseScanConfigTiers([
      { label: "Hot", maxDays: 30, intervalMs: 300_000 },
      { label: "Warm", maxDays: 7, intervalMs: 900_000 },
      { label: "Cold", maxDays: 365, intervalMs: 3_600_000 },
    ])).toHaveProperty("error");
    expect(parseScanConfigTiers([
      { label: "Hot", maxDays: 7, intervalMs: 1 },
      { label: "Warm", maxDays: 30, intervalMs: 900_000 },
      { label: "Cold", maxDays: 365, intervalMs: 3_600_000 },
    ])).toHaveProperty("error");
  });
});
