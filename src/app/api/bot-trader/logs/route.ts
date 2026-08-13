import { NextRequest, NextResponse } from 'next/server';
import { getBotActionLogs, pruneBotActionLogs, type BotActionLogRow, type BotActionStatus } from '@/lib/bot-action-log';
import { clientSafeError } from '@/lib/error-handler';
import { getBotScanDecisions } from '@/lib/bot-scan-consumer';

const VALID_STATUS = new Set<BotActionStatus>(['passed', 'failed', 'pending']);

function groupByTrade(rows: BotActionLogRow[]) {
  const groups = new Map<string, {
    tradeId: string;
    trigger: string;
    marketId: string;
    marketTitle: string;
    startedAt: string;
    status: BotActionStatus;
    qualified: boolean | null;
    steps: BotActionLogRow[];
  }>();
  for (const row of rows) {
    const group = groups.get(row.tradeId) ?? {
      tradeId: row.tradeId,
      trigger: row.trigger,
      marketId: row.marketId,
      marketTitle: row.marketTitle,
      startedAt: row.timestamp,
      status: row.responseStatus,
      qualified: row.qualificationOutcome === 'qualified' ? true : row.qualificationOutcome === 'dead' ? false : null,
      steps: [],
    };
    group.startedAt = row.timestamp < group.startedAt ? row.timestamp : group.startedAt;
    group.steps.push(row);
    if (row.responseStatus === 'failed') group.status = 'failed';
    else if (row.responseStatus === 'pending' && group.status !== 'failed') group.status = 'pending';
    if (row.qualificationOutcome === 'qualified') group.qualified = true;
    else if (row.qualificationOutcome === 'dead' && group.qualified !== true) group.qualified = false;
    groups.set(row.tradeId, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    steps: group.steps.sort((a, b) => a.id - b.id),
  })).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const params = request.nextUrl.searchParams;
    const statusParam = params.get('status');
    if (statusParam && !VALID_STATUS.has(statusParam as BotActionStatus)) {
      return NextResponse.json({ success: false, error: 'status must be passed, failed, or pending' }, { status: 400 });
    }
    const since = params.get('since') || undefined;
    if (since && !Number.isFinite(Date.parse(since))) {
      return NextResponse.json({ success: false, error: 'since must be a valid ISO date' }, { status: 400 });
    }
    const cursorParam = params.get('cursor');
    if (cursorParam != null && !/^[1-9]\d*$/.test(cursorParam)) {
      return NextResponse.json({ success: false, error: 'cursor must be a positive integer' }, { status: 400 });
    }
    const cursor = cursorParam == null ? undefined : Number(cursorParam);
    if (cursor != null && !Number.isSafeInteger(cursor)) {
      return NextResponse.json({ success: false, error: 'cursor must be a positive integer' }, { status: 400 });
    }
    const qualifiedParam = params.get('qualified');
    if (qualifiedParam && qualifiedParam !== 'true' && qualifiedParam !== 'false') {
      return NextResponse.json({ success: false, error: 'qualified must be true or false' }, { status: 400 });
    }
    await pruneBotActionLogs(30);
    const [result, decisions] = await Promise.all([getBotActionLogs({
      status: statusParam as BotActionStatus | undefined,
      marketId: params.get('marketId') || undefined,
      since,
      cursor,
      qualified: qualifiedParam == null ? undefined : qualifiedParam === 'true',
    }), getBotScanDecisions(200)]);
    return NextResponse.json({ success: true, trades: groupByTrade(result.rows), decisions, nextCursor: result.nextCursor });
  } catch (error) {
    return NextResponse.json({ success: false, error: clientSafeError(error) }, { status: 500 });
  }
}
