import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./OpportunityQueue.tsx", import.meta.url), "utf8");

describe("OpportunityQueue design contract", () => {
  it("keeps execution preparation manual and exposes required decision fields", () => {
    expect(source).toContain("Prepare manual execution");
    expect(source).toContain("Execution still requires confirmation");
    for (const label of ["Net profit", "Net ROI", "Capital", "Max fill", "Age", "Persistence", "Risk"]) {
      expect(source).toContain(label);
    }
  });

  it("provides all saved views and responsive queue-inspector behavior", () => {
    for (const view of ["Executable", "Durable", "New", "Fading", "Thin", "Stale", "Needs matching"]) {
      expect(source).toContain(`label: \"${view}\"`);
    }
    expect(source).toContain("lg:grid-cols-[minmax(0,1fr)_360px]");
    expect(source).toContain("overflow-x-auto");
  });

  it("uses semantic tokens and no raw six-digit palette values", () => {
    expect(source).toContain("var(--surface-panel)");
    expect(source.match(/#[0-9A-Fa-f]{6}/g) ?? []).toHaveLength(0);
  });
});
