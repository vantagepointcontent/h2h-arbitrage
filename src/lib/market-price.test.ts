import { describe, expect, it } from "vitest";
import { finiteMarketPrice } from "./market-price";

describe("finiteMarketPrice", () => {
  it("keeps finite non-negative prices", () => {
    expect(finiteMarketPrice("0.42")).toBe(0.42);
    expect(finiteMarketPrice(0)).toBe(0);
  });
  it("normalizes malformed, negative, and non-finite prices", () => {
    expect(finiteMarketPrice("not-a-price")).toBe(0);
    expect(finiteMarketPrice(-0.1)).toBe(0);
    expect(finiteMarketPrice(Infinity)).toBe(0);
  });
});
