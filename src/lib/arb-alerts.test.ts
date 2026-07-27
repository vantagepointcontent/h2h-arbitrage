import { describe, expect, it } from "vitest";
import { isAlertThresholdHit, makeArbAlertKey, parseArbAlerts, serializeArbAlerts } from "./arb-alerts";

describe("arb alerts", () => {
  it("keeps only valid persisted positive thresholds", () => {
    expect(parseArbAlerts(JSON.stringify({
      valid: { targetRoiPct: 3 },
      zero: { targetRoiPct: 0 },
      text: { targetRoiPct: "3" },
      malformed: null,
    }))).toEqual({ valid: { key: "valid", targetRoiPct: 3 } });
    expect(parseArbAlerts("not json")).toEqual({});
  });

  it("serializes alerts and detects a threshold at or above its target", () => {
    const alert = { key: "pair", targetRoiPct: 3 };
    expect(parseArbAlerts(serializeArbAlerts({ pair: alert }))).toEqual({ pair: alert });
    expect(isAlertThresholdHit(3, alert)).toBe(true);
    expect(isAlertThresholdHit(2.99, alert)).toBe(false);
  });

  it("makes distinct stable keys for different outcomes and platform markets", () => {
    const base = { artist: "Candidate A", strategy: "Buy YES Kalshi + NO PM", kalshiTicker: "KX-A", pmConditionId: "PM-A" };
    expect(makeArbAlertKey(base)).toBe(makeArbAlertKey(base));
    expect(makeArbAlertKey({ ...base, artist: "Candidate B" })).not.toBe(makeArbAlertKey(base));
    expect(makeArbAlertKey({ ...base, pmConditionId: "PM-B" })).not.toBe(makeArbAlertKey(base));
  });
});
