import { NextRequest, NextResponse } from 'next/server';
import { getConfigFromEnv, sendTestMessage, sendBatchAlerts, ArbAlertInput } from '@/lib/telegram-alerts';

/**
 * GET /api/telegram-alerts
 * Returns current Telegram alert configuration status.
 */
export async function GET() {
  const config = getConfigFromEnv();
  return NextResponse.json({
    configured: config !== null,
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
      const { botToken, chatId } = body;
      if (!botToken || !chatId) {
        return NextResponse.json(
          { error: 'Missing botToken or chatId' },
          { status: 400 },
        );
      }
      const result = await sendTestMessage(botToken, chatId);
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
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}