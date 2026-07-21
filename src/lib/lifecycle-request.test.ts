import { describe, expect, it } from "vitest";
import { parseLifecycleRequest } from "./lifecycle-request";

describe("parseLifecycleRequest", () => {
  it("accepts a sweep action without an id", () => {
    expect(parseLifecycleRequest({ action: "sweep" })).toEqual({ action: "sweep" });
  });

  it("accepts archive and unarchive actions with a non-empty string id", () => {
    expect(parseLifecycleRequest({ action: "archive", id: "market-1" })).toEqual({ action: "archive", id: "market-1" });
    expect(parseLifecycleRequest({ action: "unarchive", id: "market-1" })).toEqual({ action: "unarchive", id: "market-1" });
  });

  it.each([undefined, "", "other", 1])("rejects invalid actions: %j", (action) => {
    expect(parseLifecycleRequest({ action })).toEqual({ error: 'Invalid action. Use "sweep", "archive", or "unarchive".' });
  });

  it.each([undefined, "", 42, {}, []])("rejects invalid market ids: %j", (id) => {
    expect(parseLifecycleRequest({ action: "archive", id })).toEqual({ error: "Missing or invalid id" });
  });
});
