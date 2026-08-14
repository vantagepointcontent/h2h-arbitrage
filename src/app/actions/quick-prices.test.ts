import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refreshSavedMarketPrices } from './quick-prices';

describe('refreshSavedMarketPrices server action', () => {
  beforeEach(() => {
    vi.stubEnv('H2H_API_TOKEN', 'server-only-test-token');
    vi.stubEnv('PORT', '3000');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('bridges the browser refresh through the protected route without returning the API token', async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ matchedCount: 25 }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'quick-action-cid',
        'x-quick-prices-deduplicated': 'true',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshSavedMarketPrices({ marketId: 'mlb-steals', capital: 1000 });

    expect(result).toEqual({
      ok: true,
      status: 200,
      body: { matchedCount: 25 },
      retryAfter: null,
      correlationId: 'quick-action-cid',
      deduplicated: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3000/api/quick-prices');
    expect(init?.headers).toMatchObject({ 'x-h2h-token': 'server-only-test-token' });
    expect(JSON.parse(String(init?.body))).toEqual({ marketId: 'mlb-steals', capital: 1000 });
    expect(JSON.stringify(result)).not.toContain('server-only-test-token');
  });

  it('serializes actionable non-2xx results for the client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Manual price refresh is busy.', retryable: true }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'retry-after': '3' },
    })));

    await expect(refreshSavedMarketPrices({ marketId: 'busy', capital: 1000 })).resolves.toMatchObject({
      ok: false,
      status: 503,
      body: { error: 'Manual price refresh is busy.', retryable: true },
      retryAfter: '3',
    });
  });
});
