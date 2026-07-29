import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("LiveScanPanel mobile outcomes table", () => {
  it("provides a deliberate horizontal scroll surface with a sticky outcome column", () => {
    const source = readFileSync(resolve(__dirname, "LiveScanPanel.tsx"), "utf8");

    expect(source).toContain('data-testid="live-outcomes-table-scroll" className="overflow-x-auto"');
    expect(source).toContain('className="w-full min-w-[1100px] text-xs"');
    expect(source).toContain('className="sticky left-0 z-10 bg-[#17212B] text-left py-2 px-2 text-[#8A9BA8] font-medium">OUTCOME');
    expect(source).toContain('className="sticky left-0 z-10 bg-[#17212B] py-2 px-2 text-[#FFFFFF] font-medium"');
  });
});