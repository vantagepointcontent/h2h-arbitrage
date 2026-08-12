import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(new URL('./MarketFinderPanel.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const matchesRoute = readFileSync(new URL('../api/matches/route.ts', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../../lib/settings.ts', import.meta.url), 'utf8');
const scheduler = readFileSync(new URL('../../lib/auto-discovery.ts', import.meta.url), 'utf8');
const persistence = readFileSync(new URL('../../lib/persistence.ts', import.meta.url), 'utf8');

describe('UI-039 MarketFinder catalog discovery', () => {
  it('shows the scanned-not-added tab and progress stepper', () => {
    expect(panel).toContain('Scanned but not added');
    expect(panel).toContain('Fetching Kalshi markets');
    expect(panel).toContain('Fetching Polymarket markets');
    expect(panel).toContain('Matching cross-platform pairs');
    expect(panel).toContain('Verifying matched pairs');
    expect(panel).toContain('role="progressbar"');
  });

  it('streams catalog sync progress and refreshes unsaved matches', () => {
    expect(page).toContain('fetch("/api/catalog/sync"');
    expect(page).toContain('response.body.getReader()');
    expect(page).toContain('/api/matches?status=auto_queued,pending_review&notSaved=true');
  });

  it('allows matcher and MarketFinder queries to read the full catalog', () => {
    expect(persistence).toContain('Math.min(Math.max(opts.limit ?? 100, 1), 10000)');
  });

  it('supports notSaved matches and an hourly scheduled matcher refresh', () => {
    expect(matchesRoute).toContain("searchParams.get('notSaved') === 'true'");
    expect(matchesRoute).toContain('notSaved ? 5000 : limit');
    expect(settings).toMatch(/catalog\.refreshIntervalHours[^\n]+default: 1/);
    expect(scheduler).toContain('await refreshMarketCatalog()');
    expect(scheduler).toContain('await matchCrossPlatformMarkets()');
  });

  it('loads every catalog page per platform and preserves prior rows on partial Kalshi syncs', () => {
    expect(page).toContain('platform=${platform}&limit=10000&cursor=${cursor}');
    expect(page).toContain("loadPlatform('kalshi')");
    expect(page).toContain("loadPlatform('polymarket')");
    expect(readFileSync(new URL('../../lib/market-catalog.ts', import.meta.url), 'utf8'))
      .toContain("partial ? 0 : await markStaleMarketCatalog('kalshi', before)");
  });
});
