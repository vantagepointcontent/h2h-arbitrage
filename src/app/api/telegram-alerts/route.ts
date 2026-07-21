import { NextRequest, NextResponse } from 'next/server';
import { getConfigFromEnv, sendTestMessage, sendBatchAlerts, isPaused, ArbAlertInput } from '@/lib/telegram-alerts';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';
import { parseTelegramAlertsRequest } from '@/lib/telegram-alerts-request';

function authorized(request: NextRequest): boolean {
  const token = process.env.H2H_API_TOKEN;
  return !token || request.headers.get('x-h2h-token') === token;
}

/**
 * GET /api/telegram-alerts
 * Returns current Telegram alert configuration status.
 */
export async function GET() {
  const config = getConfigFromEnv();
  return NextResponse.json({
    configured: config !== null,
    paused: isPaused(),
    minRoiPct: config?.minRoiPct ?? null,
    minProfitUsd: config?.minProfitUsd ?? null,
    cooldownMs: config?.cooldownMs ?? null,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * POST /api/telegram-alerts
 * Actions:
 *   { action: 'test' } — send a test message using configured environment credentials
 */
export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = await parseJsonObject(request);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const body = parseTelegramAlertsRequest(parsed.body);
  if ('error' in body) return NextResponse.json({ error: body.error }, { status: 400 });

  try {
    // SEC-001: never accept credentials from the request body — use env
    // config only. Prevents anyone on the LAN from relaying arbitrary
    // messages through arbitrary bots via this endpoint.
    const config = getConfigFromEnv();
    if (!config) {
      return NextResponse.json(
        { error: 'Telegram alerts not configured (set env credentials)' },
        { status: 400 },
      );
    }
    const result = await sendTestMessage(config.botToken, config.chatId);
    return NextResponse.json(result, { status: result.sent ? 200 : 500 });
  } catch (err) {
    const msg = clientSafeError(err, 'Telegram alert action failed');
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}