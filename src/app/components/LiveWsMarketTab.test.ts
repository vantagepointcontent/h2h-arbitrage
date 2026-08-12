import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("Live WS market-detail navigation", () => {
  it("removes Live WS from global navigation while preserving the internal direct view", () => {
    const sidebar = read("src/app/components/MarketSidebar.tsx");
    const page = read("src/app/page.tsx");

    expect(sidebar).not.toContain('label="Live WS"');
    expect(page).not.toContain('title="Live WebSocket scan"');
    expect(page).toContain('} else if (view === "live") {');
    expect(page).toContain('viewMode === "live" ? (');
  });

  it("adds Live WS to the market workspace tabs and scopes the panel to the active market", () => {
    const header = read("src/app/components/market/MarketWorkspaceHeader.tsx");
    const page = read("src/app/page.tsx");
    const livePanel = read("src/app/components/LiveScanPanel.tsx");

    expect(header).toContain('| "live"');
    expect(header).toContain('["live","Live WS"]');
    expect(page).toContain('marketWorkspaceTab === "live"');
    expect(page).toContain('initialMarketId={activeMarketId}');
    expect(page).toContain('key={activeMarketId}');
    expect(livePanel).toContain('initialMarketId?: string;');
    expect(livePanel).toContain('useState<string>(initialMarketId ?? "")');
    expect(livePanel).toContain('tabsRef.current.forEach((tab) => {');
  });
});
