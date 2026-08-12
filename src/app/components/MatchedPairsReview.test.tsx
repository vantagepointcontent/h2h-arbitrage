// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MatchedPairsReview from "./MatchedPairsReview";

const pair = {
  id: 7,
  kalshiMarketId: "KXTRUMP-26",
  polymarketMarketId: "0xcondition",
  kalshiTitle: "Will Trump win the 2026 election?",
  polymarketTitle: "Trump wins 2026 presidential election?",
  kalshiUrl: "https://kalshi.com/markets/KXTRUMP-26",
  polymarketUrl: "https://polymarket.com/event/trump-wins-2026",
  confidence: 75,
  confidenceBreakdown: {
    nameSimilarity: 15,
    entityMatch: 30,
    categoryMatch: 20,
    expiryProximity: 10,
  },
  status: "pending_review",
  matchedAt: "2026-08-09T00:00:00.000Z",
  verifiedAt: "2026-08-09T00:00:01.000Z",
};

describe("MatchedPairsReview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows verified URLs, confidence reasons, and approve/reject actions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pairs: [pair] }) })
      .mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<MatchedPairsReview />);

    expect(await screen.findByText("Pending match review")).toBeTruthy();
    expect(screen.getByText("Name 15/40")).toBeTruthy();
    expect(screen.getByText("Entities 30/30")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Kalshi market" }).getAttribute("href")).toBe(pair.kalshiUrl);
    expect(screen.getByRole("link", { name: "Open Polymarket market" }).getAttribute("href")).toBe(pair.polymarketUrl);
    expect(screen.getByRole("button", { name: "Reject match" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve match" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/matches/7/approve", { method: "POST" }));
  });
});
