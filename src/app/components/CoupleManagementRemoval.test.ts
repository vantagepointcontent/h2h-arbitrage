import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const page = readFileSync(resolve(root, 'src/app/page.tsx'), 'utf8');
const sidebar = readFileSync(resolve(root, 'src/app/components/MarketSidebar.tsx'), 'utf8');
const persistence = readFileSync(resolve(root, 'src/lib/persistence.ts'), 'utf8');

const legacyDashboardNormalization = /window\.history\.replaceState\(\{ view: "dashboard" \}, "", "\/\?view=dashboard"\);\s+setViewMode\("dashboard"\);/;

describe('obsolete Couple Management removal', () => {
  it('removes desktop and mobile navigation and the obsolete page state', () => {
    expect(page).not.toContain('CoupleManagementPanel');
    expect(page).not.toContain('goToCoupleManagement');
    expect(page).not.toContain('viewMode === "couple-management"');
    expect(sidebar).not.toContain('Couple Mgmt');
    expect(sidebar).not.toContain('onGoCoupleManagement');
  });

  it('normalizes a direct legacy URL to Dashboard before rendering, including refresh', () => {
    expect(page).toContain('} else if (view === "couple-management") {');
    expect(page).toMatch(legacyDashboardNormalization);
  });

  it('normalizes legacy popstate and handles normalized Dashboard revisits deterministically', () => {
    expect(page).toContain('} else if (state?.view === "couple-management") {');
    expect(page).toMatch(legacyDashboardNormalization);
    expect(page).toContain('} else if (state?.view === "dashboard") {\n        setViewMode("dashboard");\n        setActiveMarketId(null);');
  });

  it('removes only the exclusive management API/helper and keeps stored coupling workflows', () => {
    expect(existsSync(resolve(root, 'src/app/api/uncoupled-markets/route.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'src/app/components/CoupleManagementPanel.tsx'))).toBe(false);
    expect(persistence).not.toContain('getUncoupledEvents');

    expect(page).toContain('CouplingSuggestions');
    expect(page).toContain('ManualMatchPanel');
    expect(page).toContain('Active Couplings');
    expect(existsSync(resolve(root, 'src/app/api/couplings/route.ts'))).toBe(true);
    expect(existsSync(resolve(root, 'src/app/api/manual-matches/route.ts'))).toBe(true);
  });
});
