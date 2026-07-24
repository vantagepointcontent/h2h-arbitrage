import { NextRequest, NextResponse } from 'next/server';
import { getExecutionByArbId } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';

/**
 * GET /api/trades/[id]/execution — step-by-step execution timeline for a test trade.
 *
 * Returns chronologically ordered execution steps with timestamps, statuses,
 * and human-readable descriptions.  Also includes fill details, alerts, and
 * completion status so the Trades page can render a rich timeline.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Missing trade id' },
        { status: 400 }
      );
    }

    const record = await getExecutionByArbId(id);
    if (!record) {
      return NextResponse.json(
        { success: false, error: `Trade not found: ${id}` },
        { status: 404 }
      );
    }

    const result = (record.result ?? {}) as Record<string, any>;
    const steps = (record.steps ?? result.steps ?? []) as Array<{
      timestamp: string;
      status: string;
      description: string;
      metadata?: Record<string, unknown>;
    }>;

    const data = {
      arbId: record.arbId,
      marketTitle: record.marketTitle,
      timestamp: record.timestamp,
      dryRun: record.dryRun,
      success: record.success,
      strategy: record.strategy,
      estimatedProfit: record.estimatedProfit,
      executionTimeMs: result.executionTimeMs ?? 0,
      kalshiResult: result.kalshiResult ?? null,
      polymarketResult: result.polymarketResult ?? null,
      actualProfit: result.actualProfit ?? null,
      netExposure: result.netExposure ?? null,
      rollbackExecuted: result.rollbackExecuted ?? false,
      unhedged: result.unhedged ?? false,
      tickCheck: result.tickCheck ?? null,
      alerts: result.alerts ?? [],
      steps,
    };

    return NextResponse.json(
      { success: true, data },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
    );
  } catch (err) {
    return NextResponse.json(
      { success: false, error: clientSafeError(err) },
      { status: 500 }
    );
  }
}
