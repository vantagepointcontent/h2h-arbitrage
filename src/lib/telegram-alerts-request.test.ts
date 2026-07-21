import { describe, expect, it } from "vitest";
import { parseTelegramAlertsRequest } from "./telegram-alerts-request";

describe("parseTelegramAlertsRequest", () => {
  it("accepts only the test action", () => {
    expect(parseTelegramAlertsRequest({ action: "test" })).toEqual({ action: "test" });
  });

  it.each([undefined, "", "send", {}, []])("rejects unsupported actions: %j", (action) => {
    expect(parseTelegramAlertsRequest({ action })).toEqual({ error: 'Unknown action. Use "test".' });
  });
});
