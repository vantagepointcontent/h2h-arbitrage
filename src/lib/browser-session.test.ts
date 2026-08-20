import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_SESSION_COOKIE,
  createBrowserSession,
  isAuthorizedBrowserMutation,
  verifyBrowserSession,
} from './browser-session';

describe('server-issued browser session', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('issues an opaque signed value that never contains the service credential', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'internal-service-credential');
    const session = await createBrowserSession({ now: 1_700_000_000_000, nonce: 'browser-nonce' });

    expect(BROWSER_SESSION_COOKIE).toBe('h2h_browser_session');
    expect(session.value).not.toContain('internal-service-credential');
    expect(session.value).not.toContain('browser-nonce');
    await expect(verifyBrowserSession(session.value, { now: 1_700_000_001_000 })).resolves.toBe(true);
  });

  it('rejects missing, tampered, and expired sessions', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'internal-service-credential');
    const session = await createBrowserSession({ now: 1_700_000_000_000, nonce: 'browser-nonce', maxAgeSeconds: 60 });

    await expect(verifyBrowserSession(null, { now: 1_700_000_001_000 })).resolves.toBe(false);
    await expect(verifyBrowserSession(`${session.value}x`, { now: 1_700_000_001_000 })).resolves.toBe(false);
    await expect(verifyBrowserSession(session.value, { now: 1_700_000_061_000 })).resolves.toBe(false);
  });

  it('authorizes either the internal service header or a same-origin signed browser cookie', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'internal-service-credential');
    const session = await createBrowserSession();
    const browserRequest = new Request('http://localhost/api/settings', {
      method: 'POST',
      headers: { origin: 'http://localhost', cookie: `${BROWSER_SESSION_COOKIE}=${session.value}` },
    });
    const serviceRequest = new Request('http://localhost/api/settings', {
      method: 'POST', headers: { 'x-h2h-token': 'internal-service-credential' },
    });
    const crossOriginRequest = new Request('http://localhost/api/settings', {
      method: 'POST',
      headers: { origin: 'https://attacker.example', cookie: `${BROWSER_SESSION_COOKIE}=${session.value}` },
    });

    await expect(isAuthorizedBrowserMutation(browserRequest)).resolves.toBe(true);
    await expect(isAuthorizedBrowserMutation(serviceRequest)).resolves.toBe(true);
    await expect(isAuthorizedBrowserMutation(crossOriginRequest)).resolves.toBe(false);
  });

  it('keeps browser sessions bound to the dedicated secret rather than service-token rotation', async () => {
    vi.stubEnv('H2H_BROWSER_SESSION_SECRET', 'dedicated-browser-session-secret');
    vi.stubEnv('H2H_API_TOKEN', 'service-token-before-rotation');
    const session = await createBrowserSession();

    vi.stubEnv('H2H_API_TOKEN', 'service-token-after-rotation');

    await expect(verifyBrowserSession(session.value)).resolves.toBe(true);
  });
});
