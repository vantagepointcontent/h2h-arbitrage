// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CouplingPanel from "./CouplingPanel";

const canonicalMarkets = [
  { ticker: "KXH200-4.00", title: "H200 compute price" },
  { ticker: "KXH200-4.50", title: "H200 compute price" },
  { ticker: "kxh200-4.50", title: "Duplicate identifier" },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    marketScopeKey: "market-h200:scan-1",
    kalshiUrl: "https://kalshi.com/markets/kxh200/h200/kxh200-26aug",
    polymarketUrl: "https://polymarket.com/event/h200",
    outcomes: [],
    unmatchedKalshi: [{ ticker: "KXH200-4.00", title: "Generic H200 title", yesAsk: 0.4, noAsk: 0.6 }],
    unmatchedPolymarket: [{ conditionId: "PM-RANGE-1", title: "$4.00 to $4.50", yesPrice: 0.3, noPrice: 0.7 }],
    manualMatches: [],
    decoupledPairs: [],
    onRescan: vi.fn(),
    onDecouple: vi.fn(async () => {}),
    onRemoveManualMatch: vi.fn(async () => {}),
    onReconcple: vi.fn(async () => {}),
    onCreateMatch: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    kalshi: canonicalMarkets,
    polymarket: [],
    source: "event-scoped",
    cached: false,
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CouplingPanel canonical Kalshi outcomes", () => {
  it("keeps same-title outcomes with distinct tickers and deduplicates identical ticker IDs", async () => {
    render(<CouplingPanel {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add New" }));

    const kalshiSelect = await screen.findByRole("combobox", { name: "Kalshi market" });
    await waitFor(() => expect(within(kalshiSelect).getAllByRole("option")).toHaveLength(3));

    const optionLabels = within(kalshiSelect).getAllByRole("option").map(option => option.textContent);
    expect(optionLabels).toEqual([
      "Select Kalshi market...",
      "H200 compute price · KXH200-4.00",
      "H200 compute price · KXH200-4.50",
    ]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/all-markets?kalshiUrl="),
      expect.objectContaining({ headers: { "Cache-Control": "no-cache" } }),
    );
  });

  it("creates a coupling with the selected canonical ticker and label", async () => {
    const onCreateMatch = vi.fn(async () => {});
    render(<CouplingPanel {...props({ onCreateMatch })} />);
    fireEvent.click(screen.getByRole("button", { name: "Add New" }));

    const kalshiSelect = await screen.findByRole("combobox", { name: "Kalshi market" });
    await waitFor(() => expect(within(kalshiSelect).getAllByRole("option")).toHaveLength(3));
    fireEvent.change(kalshiSelect, { target: { value: "KXH200-4.50" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Polymarket market" }), { target: { value: "PM-RANGE-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Coupling" }));

    await waitFor(() => expect(onCreateMatch).toHaveBeenCalledWith(
      "KXH200-4.50",
      "PM-RANGE-1",
      "H200 compute price",
      "$4.00 to $4.50",
    ));
  });

  it("clears old options while a newly selected market is loading", async () => {
    let resolveSecond: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ kalshi: canonicalMarkets }), { status: 200 }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveSecond = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<CouplingPanel {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add New" }));
    expect(await screen.findByRole("combobox", { name: "Kalshi market" })).toBeTruthy();

    rerender(<CouplingPanel {...props({
      marketScopeKey: "market-other:scan-2",
      kalshiUrl: "https://kalshi.com/markets/other/event/other-1",
    })} />);

    expect(await screen.findByText("Loading all Kalshi outcomes for this event…")).toBeTruthy();
    expect(screen.queryByText("H200 compute price · KXH200-4.50")).toBeNull();

    resolveSecond?.(new Response(JSON.stringify({ kalshi: [] }), { status: 200 }));
    expect(await screen.findByText("No eligible Kalshi outcomes were found for this event URL.")).toBeTruthy();
  });

  it("surfaces a specific event-outcome load error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Kalshi upstream unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })));
    render(<CouplingPanel {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add New" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Unable to load Kalshi outcomes: Kalshi upstream unavailable",
    );
  });
});
