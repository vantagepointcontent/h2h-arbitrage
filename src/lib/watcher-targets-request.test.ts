import { describe, expect, it } from "vitest";
import { parseWatcherTargetsRequest } from "./watcher-targets-request";

describe("parseWatcherTargetsRequest", () => {
  it("accepts refresh", () => {
    expect(parseWatcherTargetsRequest({ action: "refresh" })).toEqual({ action: "refresh" });
  });

  it("accepts and trims a valid promotion id", () => {
    expect(parseWatcherTargetsRequest({ action: "promote", pairId: " pair-1 " }))
      .toEqual({ action: "promote", pairId: "pair-1" });
  });

  it.each([undefined, "", {}, [], "x".repeat(129)])("rejects invalid promotion ids: %j", (pairId) => {
    expect(parseWatcherTargetsRequest({ action: "promote", pairId })).toEqual({ error: "Missing or invalid pairId" });
  });

  it.each([undefined, "other", 1])("rejects unknown actions: %j", (action) => {
    expect(parseWatcherTargetsRequest({ action })).toEqual({ error: "Unknown action" });
  });
});
