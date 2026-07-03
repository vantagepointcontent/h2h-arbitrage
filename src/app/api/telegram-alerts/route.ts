import { NextRequest, NextResponse } from 'next/server';
import { getConfigFromEnv, sendTestMessage, sendBatchAlerts, isPaused, ArbAlertInput } from '@/lib/telegram-alerts';
import { clientSafeError } from '@/lib/error-handler';

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
 *   { action: 'test' } — send a test message using provided botToken + chatId
 *   { action: 'send', arbs: [...] } — send batch alerts (internal use from scan loop)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'test') {
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
    }

    if (action === 'send') {
      const { arbs } = body as { arbs: ArbAlertInput[] };
      if (!Array.isArray(arbs)) {
        return NextResponse.json(
          { error: 'Missing or invalid "arbs" array' },
          { status: 400 },
        );
      }
      const result = await sendBatchAlerts(arbs);
      return NextResponse.json(result);
    }

    return NextResponse.json(
      { error: 'Unknown action. Use "test" or "send".' },
      { status: 400 },
    );
  } catch (err) {
    const msg = clientSafeError(err, 'Telegram alert action failed');
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}