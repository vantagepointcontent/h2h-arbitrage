import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserSession } from '@/lib/browser-session';

const sessionMocks = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn(() => sessionMocks.value ? { value: sessionMocks.value } : undefined),
  })),
}));

import { refreshSavedMarketsList } from './saved-markets-list';

describe('refreshSavedMarketsList server action', () => {
  beforeEach(async () => {
    vi.stubEnv('H2H_API_TOKEN', 'server-only-list-token');
    vi.stubEnv('PORT', '3000');
    sessionMocks.value = (await createBrowserSession()).value;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('injects the internal credential on loopback and returns only the canonical persisted snapshot', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      markets: [{ id: 'market-1', eventTitle: 'Market 1' }],
      revision: 'rev-2', observedAt: '2026-08-19T15:00:00.000Z', source: 'persisted-saved-markets',
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-correlation-id': 'list-cid' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshSavedMarketsList();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3000/api/saved-markets/list-refresh', expect.objectContaining({
      method: 'POST', cache: 'no-store', headers: { 'x-h2h-token': 'server-only-list-token' },
    }));
    expect(result).toMatchObject({ ok: true, status: 200, revision: 'rev-2', source: 'persisted-saved-markets' });
    expect(JSON.stringify(result)).not.toContain('server-only-list-token');
  });

  it('returns mirrored rows with an explicit degraded reason instead of reporting an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      markets: [{ id: 'market-1', eventTitle: 'Market 1' }],
      revision: 'rev-mirror', observedAt: '2026-09-02T11:35:06.000Z',
      source: 'saved-markets-json-mirror', degradedReason: 'canonical_sqlite_busy',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(refreshSavedMarketsList()).resolves.toMatchObject({
      ok: true,
      markets: [{ id: 'market-1' }],
      source: 'saved-markets-json-mirror',
      degradedReason: 'canonical_sqlite_busy',
      message: 'Canonical Saved Markets are temporarily unavailable because the database is busy. Showing the latest validated persisted mirror.',
    });
  });

  it('rejects a missing browser session before the internal service hop', async () => {
    sessionMocks.value = null;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSavedMarketsList()).resolves.toMatchObject({
      ok: false, status: 401, markets: null,
      message: 'The saved-markets session is no longer authorized. Reload the app and try again.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an expired browser session before the internal service hop', async () => {
    sessionMocks.value = (await createBrowserSession({ now: Date.now() - 120_000, maxAgeSeconds: 60 })).value;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSavedMarketsList()).resolves.toMatchObject({ ok: false, status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, { error: 'unauthorized' }, 'The saved-markets session is no longer authorized. Reload the app and try again.'],
    [503, { error: 'database unavailable' }, 'Saved markets are unavailable. Try Refresh again.'],
  ])('maps %i failures to bounded client-safe errors', async (status, body, expectedMessage) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
    await expect(refreshSavedMarketsList()).resolves.toMatchObject({ ok: false, status, markets: null, message: expectedMessage });
  });
});
