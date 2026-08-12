import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => readFileSync(`${process.cwd()}/${relativePath}`, 'utf8');

describe('BUG-132 Opportunity Queue canonical navigation', () => {
  it('supports direct URL, popstate, replaceState, and one dedicated panel rendering', () => {
    const page = read('src/app/page.tsx');
    const sidebar = read('src/app/components/MarketSidebar.tsx');
    const overview = read('src/app/components/OverviewPanel.tsx');

    expect(page).toContain('| "opportunities"');
    expect(page).toContain('state?.view === "opportunities"');
    expect(page).toContain('view === "opportunities"');
    expect(page).toContain('window.history.replaceState({ view: "opportunities" }, "", "/?view=opportunities")');
    expect(page).toContain('mode={viewMode === "opportunities" ? "opportunities" : "markets"}');
    expect(sidebar).toContain('label="Opportunity Queue"');
    expect(overview.match(/<OpportunityQueue/g)).toHaveLength(1);
  });
});