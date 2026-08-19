import { NextRequest, NextResponse } from 'next/server';
import { runBotSettlementReconciler } from '@/lib/bot-settlement-reconciler';
import { clientSafeError } from '@/lib/error-handler';

function authorized(request: NextRequest): boolean {
  const token = process.env.H2H_API_TOKEN;
  return !token || request.headers.get('x-h2h-token') === token;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await runBotSettlementReconciler();
    return NextResponse.json(
      { success: true, ...result },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: clientSafeError(error, 'Settlement reconciliation is temporarily unavailable', {
        path: '/api/bot-trader/reconcile-settlements',
      }),
    }, { status: 503, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
  }
}
