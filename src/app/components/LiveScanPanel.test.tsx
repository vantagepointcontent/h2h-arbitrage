// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LiveScanPanel from "./LiveScanPanel";

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => { this.readyState = FakeEventSource.CLOSED; });

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  transientError() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }
}

const market = {
  id: "market-1",
  eventTitle: "Test market",
  kalshiUrl: "https://kalshi.com/markets/test",
  polymarketUrl: "https://polymarket.com/event/test",
  createdAt: "2026-08-12T00:00:00.000Z",
};

const outcome = {
  artist: "Outcome A",
  kalshiYesAsk: 0.4,
  kalshiNoAsk: 0.6,
  kalshiYesDepth: 100,
  kalshiNoDepth: 100,
  pmYesAsk: 0.45,
  pmNoAsk: 0.55,
  pmYesDepth: 100,
  pmNoDepth: 100,
  kalshiYesAskShares: 10,
  kalshiNoAskShares: 10,
  pmYesAskShares: 10,
  pmNoAskShares: 10,
  strategy: "No arb",
  roiPct: 0,
  expectedProfit: 0,
  kalshiStake: 5,
  pmStake: 5,
  fees: null,
  lastUpdate: "2026-08-12T00:00:01.000Z",
};

function startLiveScan() {
  render(<LiveScanPanel capital={10} savedMarkets={[market]} initialMarketId={market.id} />);
  fireEvent.click(screen.getByRole("button", { name: "Start Live Scan" }));
  act(() => vi.advanceTimersByTime(50));
  return FakeEventSource.instances[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LiveScanPanel mobile outcomes table", () => {
  it("provides a deliberate horizontal scroll surface with a sticky outcome column", () => {
    const source = readFileSync(resolve(__dirname, "LiveScanPanel.tsx"), "utf8");

    expect(source).toContain('data-testid="live-outcomes-table-scroll" className="overflow-x-auto"');
    expect(source).toContain('className="w-full min-w-[1100px] text-xs"');
    expect(source).toContain('className="sticky left-0 z-10 bg-[#17212B] text-left py-2 px-2 text-[#8A9BA8] font-medium">OUTCOME');
    expect(source).toContain('className="sticky left-0 z-10 bg-[#17212B] py-2 px-2 text-[#FFFFFF] font-medium"');
  });
});

describe("LiveScanPanel stream recovery", () => {
  it("recovers from a transient reconnect and clears stale status when results resume", () => {
    const stream = startLiveScan();

    act(() => {
      stream.open();
      stream.message({ type: "status", message: "Connecting to exchanges..." });
      stream.message({ type: "result", result: { outcomes: [outcome], lastUpdate: outcome.lastUpdate } });
    });
    expect(screen.getByText("Streaming live prices")).toBeTruthy();
    expect(screen.getByText("Outcome A")).toBeTruthy();

    act(() => stream.transientError());
    expect(screen.getByText("Reconnecting to live prices... Last known prices remain visible. If this persists, press Stop then Start.")).toBeTruthy();
    expect(screen.getByText("Outcome A")).toBeTruthy();

    act(() => stream.message({
      type: "result",
      result: { outcomes: [outcome], lastUpdate: "2026-08-12T00:00:02.000Z" },
    }));
    expect(screen.getByText("Streaming live prices")).toBeTruthy();
    expect(screen.queryByText(/Reconnecting to live prices/)).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("surfaces exchange initialization failures as actionable disconnected state", () => {
    const stream = startLiveScan();

    act(() => stream.message({ type: "error", error: "Failed to connect to exchanges. Kalshi unavailable" }));

    expect(screen.getByText("Live scan disconnected — press Start to retry.")).toBeTruthy();
    expect(screen.getByText("Failed to connect to exchanges. Kalshi unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it("keeps configuration failures retryable instead of leaving the tab running", () => {
    render(
      <LiveScanPanel
        capital={10}
        savedMarkets={[{ ...market, polymarketUrl: "" }]}
        initialMarketId={market.id}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Start Live Scan" }));
    act(() => vi.advanceTimersByTime(50));

    expect(screen.getByText("Live scan disconnected — press Start to retry.")).toBeTruthy();
    expect(screen.getByText("Missing Kalshi or Polymarket URL.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("times out initialization instead of remaining on connecting forever", () => {
    const stream = startLiveScan();
    act(() => {
      stream.open();
      stream.message({ type: "status", message: "Connecting to exchanges..." });
      vi.advanceTimersByTime(15_000);
    });

    expect(screen.getByText("Live scan disconnected — press Start to retry.")).toBeTruthy();
    expect(screen.getByText("Exchange initialization timed out. Check venue availability, then press Start to retry.")).toBeTruthy();
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it("closes the sole stream on unmount without creating reconnect duplicates", () => {
    const stream = startLiveScan();
    act(() => {
      stream.open();
      stream.transientError();
      stream.open();
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    cleanup();
    expect(stream.close).toHaveBeenCalledTimes(1);
  });
});