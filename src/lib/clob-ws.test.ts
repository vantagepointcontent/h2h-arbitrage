import { describe, expect, it } from "vitest";
import { ClobWsService, type WsPriceUpdate } from "./clob-ws";

describe("ClobWsService malformed market-data handling", () => {
  it("fails closed when a best-bid/ask update contains non-finite prices", () => {
    const service = new ClobWsService();
    let received: WsPriceUpdate[] = [];
    service.subscribe(["token-1"], (updates) => { received = updates; }, "test-subscription");

    // Exercise the WebSocket message boundary without opening a network socket.
    (service as unknown as { handleMessage(raw: string): void }).handleMessage(JSON.stringify({
      type: "best_bid_ask",
      asset_id: "token-1",
      bid_price: "Infinity",
      ask_price: "not-a-number",
      timestamp: 1,
    }));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ bestBid: null, bestAsk: null });
  });

  it("excludes non-finite snapshot levels from prices and executable depth", () => {
    const service = new ClobWsService();
    let received: WsPriceUpdate[] = [];
    service.subscribe(["token-2"], (updates) => { received = updates; }, "test-subscription");

    (service as unknown as { handleMessage(raw: string): void }).handleMessage(JSON.stringify({
      type: "book",
      asset_id: "token-2",
      bids: [{ price: "Infinity", size: "10" }, { price: "0.40", size: "3" }],
      asks: [{ price: "NaN", size: "10" }, { price: "0.60", size: "Infinity" }],
      timestamp: 1,
    }));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ bestBid: 0.4, bestAsk: null });
    expect(received[0].book).toEqual({ bids: [{ price: 0.4, size: 3 }], asks: [] });
  });
});
