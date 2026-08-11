// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";

const { getSpreadsForOutcome } = vi.hoisted(() => ({
  getSpreadsForOutcome: vi.fn(),
}));

vi.mock("@/lib/spreadHistory", () => ({
  getSpreadsForOutcome,
}));

import { ArbHistoryCell } from "./ArbHistoryCell";

describe("ArbHistoryCell refresh lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSpreadsForOutcome.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("re-reads new samples and leaves the collecting state without a remount", async () => {
    getSpreadsForOutcome
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ts: 1, roiPct: 1 }, { ts: 2, roiPct: 2 }, { ts: 3, roiPct: 3 },
        { ts: 4, roiPct: 4 }, { ts: 5, roiPct: 5 },
      ]);

    render(<ArbHistoryCell marketId="m1" outcomeArtist="Winner" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("0/5 samples")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(getSpreadsForOutcome).toHaveBeenCalledTimes(2);
    expect(screen.getByText("+5.0%")).toBeTruthy();
  });
});
