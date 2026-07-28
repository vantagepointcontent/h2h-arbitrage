// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ManualMatchPanel from "./ManualMatchPanel";

const props = {
  unmatchedKalshi: [{ ticker: "KX-1", title: "Kalshi outcome", yesAsk: 0.42, noAsk: 0.58 }],
  unmatchedPolymarket: [{ conditionId: "PM-1", title: "Polymarket outcome", yesPrice: 0.43, noPrice: 0.57 }],
  activeMatches: [{ id: "match-1", kalshiTicker: "KX-1", kalshiTitle: "Kalshi outcome", pmConditionId: "PM-1", pmTitle: "Polymarket outcome" }],
  onPair: vi.fn(),
  onUnpair: vi.fn(),
};

describe("ManualMatchPanel mobile layout", () => {
  it("keeps controls touch-sized and stacks the market selectors below the md breakpoint", () => {
    render(<ManualMatchPanel {...props} />);

    expect(screen.getByRole("button", { name: "Unlink this pair" }).className).toContain("min-h-11");
    expect(screen.getByRole("button", { name: "Link" }).className).toContain("min-h-11");
    expect(screen.getByPlaceholderText("Search Kalshi markets…").className).toContain("min-h-11");
    expect(screen.getByPlaceholderText("Search Polymarket markets…").className).toContain("min-h-11");

    const kalshiOption = screen.getByRole("button", { name: /Kalshi outcome/ });
    expect(kalshiOption.className).toContain("min-h-11");
    expect(kalshiOption.parentElement?.parentElement?.className).toContain("md:border-r");
  });
});
