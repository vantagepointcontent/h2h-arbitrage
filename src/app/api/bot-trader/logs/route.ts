import { NextRequest, NextResponse } from 'next/server';
import { getBotActionLogs, pruneBotActionLogs, type BotActionLogRow, type BotActionStatus } from '@/lib/bot-action-log';
import { clientSafeError } from '@/lib/error-handler';
import { getBotScanDecisions, type BotScanDecisionState } from '@/lib/bot-scan-consumer';
import { getScanAuditReferences } from '@/lib/persistence';

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
    positiveArb: boolean;
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
      positiveArb: row.positiveArb,
      steps: [],
    };
    group.startedAt = row.timestamp < group.startedAt ? row.timestamp : group.startedAt;
    group.steps.push(row);
    if (row.responseStatus === 'failed') group.status = 'failed';
    else if (row.responseStatus === 'pending' && group.status !== 'failed') group.status = 'pending';
    if (row.qualificationOutcome === 'qualified') group.qualified = true;
    else if (row.qualificationOutcome === 'dead' && group.qualified !== true) group.qualified = false;
    if (row.positiveArb) group.positiveArb = true;
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
    const positiveArbParam = params.get('positiveArb');
    if (positiveArbParam && positiveArbParam !== 'true' && positiveArbParam !== 'false') {
      return NextResponse.json({ success: false, error: 'positiveArb must be true or false' }, { status: 400 });
    }
    await pruneBotActionLogs(30);
    const qualified = qualifiedParam == null ? undefined : qualifiedParam === 'true';
    const positiveArb = positiveArbParam === 'true' || qualified === true;
    const [result, decisions] = await Promise.all([getBotActionLogs({
      status: statusParam as BotActionStatus || undefined,
      marketId: params.get('marketId') || undefined,
      since,
      cursor,
      qualified,
      positiveArb,
    }), qualified === true ? Promise.resolve([]) : getBotScanDecisions({
      limit: 200,
      positiveArbOnly: positiveArb,
      status: statusParam as BotActionStatus || undefined,
      marketId: params.get('marketId') || undefined,
      since,
    })]);
    // OPS-854: filter out pre-reset tombstoned decisions and any decisions
    // whose latest update is before the reset baseline, so the visible
    // BotTrader history starts cleanly after reset. Idempotency keys and
    // cursor state remain intact in the DB.
    const baseline = await getResetBaseline();
    const visibleDecisions = decisions.filter((d) => {
      if (d.state === ('reset_cleared' as BotScanDecisionState)) return false;
      if (positiveArb && (d.reasonCode === 'no_positive_arb' || d.reasonCode === 'no_opportunities' || /no positive arb/i.test(d.reason))) return false;
      if (!baseline) return true;
      return d.updatedAt >= baseline.resetAt;
    });
    const auditReferences = visibleDecisions.length > 0
      ? await getScanAuditReferences(visibleDecisions.map((decision) => decision.scanId))
      : new Map();
    const enrichedDecisions = visibleDecisions.map((decision) => ({
      ...decision,
      logUuid: auditReferences.get(decision.scanId)?.logUuid ?? null,
      marketId: auditReferences.get(decision.scanId)?.marketId ?? null,
      marketName: auditReferences.get(decision.scanId)?.marketName ?? null,
    }));
    return NextResponse.json({ success: true, trades: groupByTrade(result.rows), decisions: enrichedDecisions, nextCursor: result.nextCursor });
  } catch (error) {
    return NextResponse.json({ success: false, error: clientSafeError(error) }, { status: 500 });
  }
}

interface ResetBaseline { resetAt: string; }

async function getResetBaseline(): Promise<ResetBaseline | null> {
  try {
    const { createClient } = await import('@libsql/client');
    const path = await import('path');
    const databasePath = process.env.H2H_SQLITE_PATH || path.join(process.cwd(), 'data', 'edgefinder.db');
    const db = createClient({ url: `file:${databasePath}` });
    try {
      const r = await db.execute('SELECT reset_at FROM bot_trader_reset_baseline ORDER BY id DESC LIMIT 1');
      const row = (r.rows as unknown as Array<Record<string, unknown>>)[0];
      return row ? { resetAt: String(row.reset_at) } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
