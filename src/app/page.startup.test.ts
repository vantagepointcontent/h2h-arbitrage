import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');

describe('BUG-108 scan startup state', () => {
  it('starts in an explicit loading state until URL and cache hydration finish', () => {
    expect(page).toContain('const [routeInitializing, setRouteInitializing] = useState(true)');
    expect(page).toContain('.finally(() => setRouteInitializing(false))');
    expect(page).toContain('routeInitializing ? (');
    expect(page).toContain('Loading workspace...');
    expect(page.indexOf('routeInitializing ? (')).toBeLessThan(page.indexOf('viewMode === "overview" ? ('));
  });

  it('logs initialization failures and exposes a readable error', () => {
    expect(page).toContain('console.error("Failed to initialize view from URL", err)');
    expect(page).toContain('setError("Failed to load the requested market.")');
  });
});