'use server';

import { cookies } from 'next/headers';
import { BROWSER_SESSION_COOKIE, verifyBrowserSession } from '@/lib/browser-session';

export interface BrowserMutationResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T | null;
  message: string | null;
  correlationId: string | null;
}

export interface SettingsMutationInput {
  values?: Record<string, unknown>;
  reset?: string;
  confirmation?: 'LIVE' | 'PRODUCTION';
  liveConfirmation?: 'LIVE';
  botConfirmation?: 'PRODUCTION';
}

export interface BotTraderRunInput {
  pairId?: string;
  marketTitle?: string;
  ranked?: boolean;
  catchUp?: boolean;
  limit?: number;
  maxCandidates?: number;
  rankedOffset?: number;
}

function internalAppUrl(): string {
  const configuredPort = Number(process.env.PORT);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : 3000;
  return `http://127.0.0.1:${port}`;
}

function boundedFailureMessage(status: number, operation: 'settings' | 'run' | 'message'): string {
  if (status === 401 || status === 403) return 'BotTrader authorization failed. Reload the app and try again.';
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    if (operation === 'settings') return 'BotTrader rejected that setting. Review the requested value and safety requirements.';
    if (operation === 'run') return 'BotTrader could not run that request. Refresh the market and try again.';
    return 'The BotTrader message test could not be sent. Check the server-side Telegram configuration.';
  }
  if (operation === 'settings') return 'BotTrader settings are temporarily unavailable. The previous settings remain active.';
  if (operation === 'run') return 'The BotTrader run is temporarily unavailable. No new run was confirmed.';
  return 'The BotTrader message service is temporarily unavailable.';
}

function failure<T>(status: number, operation: 'settings' | 'run' | 'message', correlationId: string | null = null): BrowserMutationResult<T> {
  return { ok: false, status, data: null, message: boundedFailureMessage(status, operation), correlationId };
}

function sessionFailure<T>(): BrowserMutationResult<T> {
  return {
    ok: false,
    status: 401,
    data: null,
    message: 'Your secure browser session expired. Reload the app and try again.',
    correlationId: null,
  };
}

async function validBrowserSession(): Promise<boolean> {
  const browserSession = (await cookies()).get(BROWSER_SESSION_COOKIE)?.value;
  return verifyBrowserSession(browserSession);
}

async function bridgeMutation<T>(
  path: '/api/settings' | '/api/bot-trader/run' | '/api/bot-trader/messages',
  body: Record<string, unknown>,
  operation: 'settings' | 'run' | 'message',
  timeoutMs: number,
): Promise<BrowserMutationResult<T>> {
  if (!await validBrowserSession()) return sessionFailure();

  const token = process.env.H2H_API_TOKEN;
  try {
    const response = await fetch(`${internalAppUrl()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-h2h-token': token } : {}),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const correlationId = response.headers.get('x-correlation-id');
    const payload = await response.json().catch(() => null) as T | null;
    if (!response.ok || payload == null || typeof payload !== 'object') {
      return failure(response.status || 502, operation, correlationId);
    }
    return { ok: true, status: response.status, data: payload, message: null, correlationId };
  } catch {
    return failure(503, operation);
  }
}

export async function updateSettingsFromBrowser(input: SettingsMutationInput): Promise<BrowserMutationResult> {
  const body: Record<string, unknown> = {};
  if (input.values && typeof input.values === 'object' && !Array.isArray(input.values)) body.values = input.values;
  if (typeof input.reset === 'string') body.reset = input.reset;
  if (input.confirmation) body.confirmation = input.confirmation;
  if (input.liveConfirmation) body.liveConfirmation = input.liveConfirmation;
  if (input.botConfirmation) body.botConfirmation = input.botConfirmation;
  const result = await bridgeMutation<Record<string, unknown>>('/api/settings', body, 'settings', 15_000);
  if (!result.ok) return result;
  const payload = result.data as { success?: unknown; settings?: unknown } | null;
  if (payload?.success !== true || !Array.isArray(payload.settings)) {
    return failure(502, 'settings', result.correlationId);
  }
  return result;
}

export async function runBotTraderFromBrowser(input: BotTraderRunInput): Promise<BrowserMutationResult> {
  return bridgeMutation('/api/bot-trader/run', { ...input }, 'run', 300_000);
}

export async function sendBotTraderTestMessageFromBrowser(): Promise<BrowserMutationResult> {
  return bridgeMutation('/api/bot-trader/messages', { action: 'test' }, 'message', 15_000);
}
