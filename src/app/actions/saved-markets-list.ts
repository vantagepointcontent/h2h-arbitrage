'use server';

import { cookies } from 'next/headers';
import { BROWSER_SESSION_COOKIE, verifyBrowserSession } from '@/lib/browser-session';

export interface SavedMarketsListRefreshResponse {
  ok: boolean;
  status: number;
  markets: unknown[] | null;
  revision: string | null;
  observedAt: string | null;
  source: 'persisted-saved-markets' | null;
  message: string | null;
  correlationId: string | null;
}

function internalAppUrl(): string {
  const configuredPort = Number(process.env.PORT);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535 ? configuredPort : 3000;
  return `http://127.0.0.1:${port}`;
}

function failureMessage(status: number): string {
  if (status === 401 || status === 403) {
    return 'The saved-markets session is no longer authorized. Reload the app and try again.';
  }
  return 'Saved markets are unavailable. Try Refresh again.';
}

function failure(status: number, correlationId: string | null = null): SavedMarketsListRefreshResponse {
  return {
    ok: false, status, markets: null, revision: null, observedAt: null, source: null,
    message: failureMessage(status), correlationId,
  };
}

/** Server-only bridge to the protected, persistence-only Saved Markets list refresh. */
export async function refreshSavedMarketsList(): Promise<SavedMarketsListRefreshResponse> {
  const browserSession = (await cookies()).get(BROWSER_SESSION_COOKIE)?.value;
  if (!await verifyBrowserSession(browserSession)) return failure(401);

  const token = process.env.H2H_API_TOKEN;
  try {
    const response = await fetch(`${internalAppUrl()}/api/saved-markets/list-refresh`, {
      method: 'POST',
      headers: token ? { 'x-h2h-token': token } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const correlationId = response.headers.get('x-correlation-id');
    if (!response.ok) return failure(response.status, correlationId);
    if (!payload || !Array.isArray(payload.markets) || typeof payload.revision !== 'string') {
      return failure(502, correlationId);
    }
    return {
      ok: true,
      status: response.status,
      markets: payload.markets,
      revision: payload.revision,
      observedAt: typeof payload.observedAt === 'string' ? payload.observedAt : null,
      source: payload.source === 'persisted-saved-markets' ? payload.source : null,
      message: null,
      correlationId,
    };
  } catch {
    return failure(503);
  }
}
