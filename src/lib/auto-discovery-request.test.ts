import { describe, expect, it } from "vitest";
import { parseReviewPairId } from "./auto-discovery-request";

describe("parseReviewPairId", () => {
  it("trims valid pair IDs", () => {
    expect(parseReviewPairId("  pair-123  ")).toEqual({ pairId: "pair-123" });
  });

  it("rejects empty, non-string, and oversized IDs", () => {
    expect(parseReviewPairId(" ")).toHaveProperty("error");
    expect(parseReviewPairId([])).toHaveProperty("error");
    expect(parseReviewPairId("x".repeat(129))).toHaveProperty("error");
  });
});
