import { describe, expect, it } from "vitest";
import { parseRetentionDays } from "./retention-request";

describe("parseRetentionDays", () => {
  it("defaults to 30 days", () => {
    expect(parseRetentionDays(null)).toBe(30);
    expect(parseRetentionDays("")).toBe(30);
  });

  it.each(["1", "30", "3650"])("accepts a bounded whole number: %s", (value) => {
    expect(parseRetentionDays(value)).toBe(Number(value));
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity", "3651", "abc"])("rejects unsafe input: %s", (value) => {
    expect(parseRetentionDays(value)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});
