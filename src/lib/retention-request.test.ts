import { describe, expect, it } from "vitest";
import { parseRetentionDays } from "./retention-request";

describe("parseRetentionDays", () => {
  it("defaults to the seven-day zero-arbitrage retention policy", () => {
    expect(parseRetentionDays(null)).toBe(7);
    expect(parseRetentionDays("")).toBe(7);
  });

  it.each(["1", "30", "3650"])("accepts a bounded whole number: %s", (value) => {
    expect(parseRetentionDays(value)).toBe(Number(value));
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity", "3651", "abc"])("rejects unsafe input: %s", (value) => {
    expect(parseRetentionDays(value)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});
