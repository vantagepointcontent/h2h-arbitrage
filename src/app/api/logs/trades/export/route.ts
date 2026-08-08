import { NextRequest, NextResponse } from 'next/server';
import { getClosedPositions, getExecutions } from '@/lib/persistence';
import {
  TRADE_EXPORT_HEADERS,
  closedPositionRow,
  executionRows,
  tradeCsvLine,
  type TradeExportRow,
} from '@/lib/trade-export';

function dateBounds(params: URLSearchParams) {
  const from = params.get('fromDate') || '1970-01-01';
  const to = params.get('toDate') || new Date().toISOString().slice(0, 10);
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T23:59:59.999Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    throw new Error('Invalid date range');
  }
  return { from, to, fromMs, toMs };
}

/** Accounting export: live execution legs plus persisted closed positions. */
export async function GET(request: NextRequest) {
  try {
    const bounds = dateBounds(new URL(request.url).searchParams);
    const [executions, closed] = await Promise.all([getExecutions(10_000), getClosedPositions(5_000)]);
    const rows: TradeExportRow[] = [
      ...executions.flatMap(executionRows),
      ...closed.map(closedPositionRow),
    ].filter((row) => {
      const timestamp = Date.parse(String(row[0]));
      return timestamp >= bounds.fromMs && timestamp <= bounds.toMs;
    }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('\uFEFF' + tradeCsvLine(TRADE_EXPORT_HEADERS)));
        for (const row of rows) controller.enqueue(encoder.encode(tradeCsvLine(row)));
        controller.close();
      },
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="trades_${bounds.from}_to_${bounds.to}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Trade export failed' }, { status: 400 });
  }
}
