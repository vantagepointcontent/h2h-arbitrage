import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  refreshMarketCatalog: vi.fn(),
  matchCrossPlatformMarkets: vi.fn(),
}));

vi.mock('@/lib/market-catalog', () => ({ refreshMarketCatalog: mocks.refreshMarketCatalog }));
vi.mock('@/lib/cross-platform-matcher', () => ({ matchCrossPlatformMarkets: mocks.matchCrossPlatformMarkets }));

import { POST } from './route';

afterEach(() => vi.restoreAllMocks());

describe('POST /api/catalog/sync stream lifecycle', () => {
  it('clears the heartbeat when the sync stream completes', async () => {
    mocks.refreshMarketCatalog.mockResolvedValue({
      kalshi: { fetched: 1 },
      polymarket: { fetched: 1 },
    });
    mocks.matchCrossPlatformMarkets.mockResolvedValue({
      candidatesChecked: 1,
      verifiedPairs: 1,
      autoQueued: 1,
      pendingReview: 0,
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const response = await POST(new NextRequest(
      `http://localhost/api/catalog/sync?runId=test-${crypto.randomUUID()}`,
      { method: 'POST' },
    ));
    const reader = response.body!.getReader();
    while (!(await reader.read()).done) { /* consume SSE stream */ }

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
