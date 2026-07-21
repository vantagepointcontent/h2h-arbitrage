import { describe, expect, it } from "vitest";
import { parsePolymarketConditionId } from "./polymarket-request";

const id = `0x${"a".repeat(64)}`;

describe("parsePolymarketConditionId", () => {
  it("accepts a valid condition ID", () => {
    expect(parsePolymarketConditionId(` ${id} `)).toEqual({ conditionId: id });
  });

  it("rejects absent, malformed, and path-like values", () => {
    expect(parsePolymarketConditionId(null)).toHaveProperty("error");
    expect(parsePolymarketConditionId("market/../x")).toHaveProperty("error");
    expect(parsePolymarketConditionId("0xabc")).toHaveProperty("error");
  });
});
