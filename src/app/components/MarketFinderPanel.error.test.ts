import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(new URL('./MarketFinderPanel.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');

describe('BUG-109 MarketFinder load failures', () => {
  it('treats HTTP and success=false responses as failures', () => {
    expect(page).toContain('if (!r.ok || !data?.success)');
    expect(page).toContain('throw new Error(data?.error || `MarketFinder request failed (${r.status})`)');
  });

  it('logs failures and preserves the MarketFinder view with a retryable error', () => {
    expect(page).toContain('console.error("Failed to load MarketFinder data", err)');
    expect(panel).toContain('role="alert"');
    expect(panel).toContain('MarketFinder failed to load');
    expect(panel).toContain('onClick={onFetch}');
    expect(panel).toContain('Retry');
    expect(panel).toContain('{error ? (');
  });
});