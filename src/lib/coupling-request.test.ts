import { describe, expect, it } from "vitest";
import { parseCouplingRequest } from "./coupling-request";

describe("parseCouplingRequest", () => {
  it("accepts a valid rejection and trims fields", () => {
    expect(parseCouplingRequest({
      action: "reject",
      kalshiTicker: " KX-1 ",
      pmConditionId: " 0xabc ",
      reason: " Not equivalent ",
    })).toEqual({
      action: "reject",
      kalshiTicker: "KX-1",
      pmConditionId: "0xabc",
      reason: "Not equivalent",
    });
  });

  it("accepts a valid coupling acceptance", () => {
    expect(parseCouplingRequest({ action: "accept", kalshiTicker: "KX-1", pmConditionId: "0xabc" }))
      .toEqual({ action: "accept", kalshiTicker: "KX-1", pmConditionId: "0xabc" });
  });

  it.each([undefined, "other", 1])("rejects an invalid action: %j", (action) => {
    expect(parseCouplingRequest({ action, kalshiTicker: "KX-1", pmConditionId: "0xabc" })).toEqual({ error: "Invalid action" });
  });

  it.each([undefined, "", 1, {}])("rejects invalid Kalshi tickers: %j", (kalshiTicker) => {
    expect(parseCouplingRequest({ action: "reject", kalshiTicker, pmConditionId: "0xabc" })).toEqual({ error: "Missing or invalid kalshiTicker" });
  });

  it.each([undefined, "", 1, {}])("rejects invalid PM condition IDs: %j", (pmConditionId) => {
    expect(parseCouplingRequest({ action: "reject", kalshiTicker: "KX-1", pmConditionId })).toEqual({ error: "Missing or invalid pmConditionId" });
  });
});
