import { describe, expect, it } from "vitest";
import { parseManualMatchInput } from "./manual-match-request";

describe("parseManualMatchInput", () => {
  it("normalizes valid string inputs", () => {
    expect(parseManualMatchInput({ kalshiTicker: " KXTEST ", pmConditionId: " pm-1 ", kalshiTitle: " K ", pmTitle: " P " })).toEqual({ kalshiTicker: "KXTEST", pmConditionId: "pm-1", kalshiTitle: "K", pmTitle: "P", orientation: "same", kalshiUrl: undefined, polymarketUrl: undefined, marketId: undefined });
  });

  it("rejects blank identifiers and non-string optional URLs", () => {
    expect(parseManualMatchInput({ kalshiTicker: "", pmConditionId: "pm-1" })).toEqual({ error: "kalshiTicker and pmConditionId must be non-empty strings" });
    expect(parseManualMatchInput({ kalshiTicker: "KX", pmConditionId: "pm-1", kalshiUrl: 42 })).toEqual({ error: "kalshiUrl must be a string" });
  });

  it("retains explicit inverted orientation and rejects unknown values", () => {
    expect(parseManualMatchInput({ kalshiTicker: "KX", pmConditionId: "PM", orientation: "inverted" }))
      .toEqual(expect.objectContaining({ orientation: "inverted" }));
    expect(parseManualMatchInput({ kalshiTicker: "KX", pmConditionId: "PM", orientation: "sideways" }))
      .toEqual({ error: "orientation must be same or inverted" });
  });
});
