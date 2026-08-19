import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';
import { BROWSER_SESSION_COOKIE, createBrowserSession } from './lib/browser-session';

function request(method: string, headers: Record<string, string> = {}, path = '/api/settings') {
  return new NextRequest(`http://localhost${path}`, { method, headers });
}

describe('API mutation middleware', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('does not trust a client-controlled localhost Host header', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'test-secret');

    const response = await middleware(request('POST', { host: 'localhost:3000' }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('allows a mutating API request with the configured token', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'test-secret');

    const response = await middleware(request('POST', {
      host: 'attacker.example',
      'x-h2h-token': 'test-secret',
    }));

    expect(response.status).toBe(200);
  });

  it('does not require the mutation token for GET requests', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'test-secret');

    expect((await middleware(request('GET'))).status).toBe(200);
  });

  it('issues a short-lived HttpOnly SameSite=Strict browser session on the root document', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'test-secret');
    const response = await middleware(request('GET', {}, '/'));
    const cookie = response.cookies.get(BROWSER_SESSION_COOKIE);

    expect(cookie?.value).toBeTruthy();
    expect(cookie?.value).not.toContain('test-secret');
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(response.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);
  });

  it('accepts a valid same-origin browser session without a service-token header', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'test-secret');
    const session = await createBrowserSession();
    const response = await middleware(request('POST', {
      cookie: `${BROWSER_SESSION_COOKIE}=${session.value}`,
      origin: 'http://localhost',
    }));
    expect(response.status).toBe(200);
  });

  it('rejects an expired browser session', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'test-secret');
    const expired = await createBrowserSession({ now: Date.now() - 120_000, maxAgeSeconds: 60 });
    const response = await middleware(request('POST', {
      cookie: `${BROWSER_SESSION_COOKIE}=${expired.value}`,
      origin: 'http://localhost',
    }));
    expect(response.status).toBe(401);
  });

  it('rejects a direct unauthenticated post to the protected list refresh', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'test-secret');
    const response = await middleware(request('POST', {}, '/api/saved-markets/list-refresh'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
  });
});
