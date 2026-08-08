import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(process.cwd(), "src/app/components/SettingsPanel.tsx"), "utf8");

describe("SettingsPanel save copy", () => {
  it("tells users that edits require an explicit save", () => {
    expect(source).toContain("then click Save Changes to apply them");
    expect(source).toContain('saving ? "Saving…" : "Save Changes"');
  });

  it("does not claim that changes are saved automatically", () => {
    expect(source.toLowerCase()).not.toContain("saved automatically");
    expect(source.toLowerCase()).not.toContain("applied instantly");
  });
});
