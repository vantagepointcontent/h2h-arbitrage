import { describe, expect, it } from "vitest";
import { parseJsonObject } from "./request-json";

describe("parseJsonObject", () => {
  it("returns a JSON object", async () => {
    await expect(parseJsonObject(new Request("http://test", { method: "POST", body: '{"id":"x"}' }))).resolves.toEqual({ body: { id: "x" } });
  });

  it("rejects malformed JSON and non-object bodies", async () => {
    await expect(parseJsonObject(new Request("http://test", { method: "POST", body: "{" }))).resolves.toEqual({ error: "Invalid JSON body" });
    await expect(parseJsonObject(new Request("http://test", { method: "POST", body: "[]" }))).resolves.toEqual({ error: "Expected a JSON object" });
  });
});
