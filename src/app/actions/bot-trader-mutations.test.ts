import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserSession } from '@/lib/browser-session';

const sessionMocks = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn(() => sessionMocks.value ? { value: sessionMocks.value } : undefined),
  })),
}));

import {
  runBotTraderFromBrowser,
  sendBotTraderTestMessageFromBrowser,
  updateSettingsFromBrowser,
} from './bot-trader-mutations';

describe('BotTrader browser mutation server actions', () => {
  beforeEach(async () => {
    vi.stubEnv('H2H_API_TOKEN', 'server-only-bot-token');
    vi.stubEnv('H2H_BROWSER_SESSION_SECRET', 'dedicated-browser-secret');
    vi.stubEnv('PORT', '3000');
    sessionMocks.value = (await createBrowserSession()).value;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('validates the browser session and injects the service token only on the loopback settings hop', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      settings: [{ key: 'bot.enabled', value: false, source: 'db' }],
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-correlation-id': 'settings-cid' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateSettingsFromBrowser({ values: { 'bot.enabled': false } });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3000/api/settings', expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-h2h-token': 'server-only-bot-token',
      },
      body: JSON.stringify({ values: { 'bot.enabled': false } }),
    }));
    expect(result).toMatchObject({ ok: true, status: 200, correlationId: 'settings-cid' });
    expect(JSON.stringify(result)).not.toContain('server-only-bot-token');
    expect(JSON.stringify(result)).not.toContain('dedicated-browser-secret');
  });

  it.each(['missing', 'expired', 'tampered'] as const)('rejects a %s session before any service hop', async (kind) => {
    if (kind === 'missing') sessionMocks.value = null;
    if (kind === 'expired') {
      sessionMocks.value = (await createBrowserSession({ now: Date.now() - 120_000, maxAgeSeconds: 60 })).value;
    }
    if (kind === 'tampered') sessionMocks.value = `${sessionMocks.value}x`;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateSettingsFromBrowser({ values: { 'bot.enabled': true } })).resolves.toMatchObject({
      ok: false,
      status: 401,
      message: 'Your secure browser session expired. Reload the app and try again.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403])('maps an internal %i service rejection to a bounded authorization error', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized', token: 'leak' }), { status })));

    await expect(updateSettingsFromBrowser({ values: { 'bot.enabled': true } })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status,
      message: 'BotTrader authorization failed. Reload the app and try again.',
    }));
    expect(JSON.stringify(await updateSettingsFromBrowser({ values: { 'bot.enabled': true } }))).not.toContain('unauthorized');
  });

  it('rejects a malformed successful settings response instead of clearing canonical client state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));

    await expect(updateSettingsFromBrowser({ values: { 'bot.enabled': true } })).resolves.toMatchObject({
      ok: false,
      status: 502,
      data: null,
    });
  });

  it('bridges manual paper runs and message tests through the same authenticated server-only boundary', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runBotTraderFromBrowser({ pairId: 'pair-1', marketTitle: 'Pair 1' })).resolves.toMatchObject({ ok: true });
    await expect(sendBotTraderTestMessageFromBrowser()).resolves.toMatchObject({ ok: true });

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:3000/api/bot-trader/run', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-h2h-token': 'server-only-bot-token' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:3000/api/bot-trader/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-h2h-token': 'server-only-bot-token' }),
      body: JSON.stringify({ action: 'test' }),
    }));
  });
});
