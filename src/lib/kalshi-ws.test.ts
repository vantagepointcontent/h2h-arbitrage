import { describe, expect, it } from "vitest";
import { KalshiWsService, type KalshiWsMessage } from "./kalshi-ws";

describe("KalshiWsService malformed market-data handling", () => {
  it("excludes non-finite and out-of-range snapshot levels", () => {
    const service = new KalshiWsService();
    let received: KalshiWsMessage | null = null;
    service.subscribe("KXTEST", (message) => { received = message; }, "test-snapshot");

    (service as unknown as { handleMessage(raw: string): void }).handleMessage(JSON.stringify({
      type: "orderbook_snapshot",
      msg: {
        market_ticker: "KXTEST",
        market_id: "market-1",
        yes_dollars_fp: [["Infinity", "10"], ["0.42", "Infinity"], ["1.2", "10"], ["0.42", "5"]],
        no_dollars_fp: [["0.58", "3"]],
      },
    }));

    expect(received).toMatchObject({
      type: "orderbook_snapshot",
      yes: [{ price: 0.42, quantity: 5 }],
      no: [{ price: 0.58, quantity: 3 }],
    });
  });

  it("drops malformed deltas instead of dispatching non-executable quotes", () => {
    const service = new KalshiWsService();
    let received = 0;
    service.subscribe("KXTEST", () => { received++; }, "test-delta");

    (service as unknown as { handleMessage(raw: string): void }).handleMessage(JSON.stringify({
      type: "orderbook_delta",
      msg: { market_ticker: "KXTEST", side: "yes", price_dollars: "NaN", delta_fp: "10" },
    }));
    (service as unknown as { handleMessage(raw: string): void }).handleMessage(JSON.stringify({
      type: "orderbook_delta",
      msg: { market_ticker: "KXTEST", side: "yes", price_dollars: "0.42", delta_fp: "Infinity" },
    }));

    expect(received).toBe(0);
  });
});