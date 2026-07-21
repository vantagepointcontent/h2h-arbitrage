// WS-103: Watch-target management endpoint.
// GET  /api/watcher/targets            — current tier assignment + stats
// POST /api/watcher/targets            — { action: 'refresh' } re-resolve stale pairs
//                                        { action: 'promote', pairId } flag a pair HOT (poller hook)
// Mutations require the shared API token (same scheme as other mutating routes).

import { NextRequest, NextResponse } from 'next/server';
import { refreshWatchTargets, computeTiers, flagForPromotion, getTierState } from '@/lib/watch-targets';
import logger from '@/lib/logger';
import { parseJsonObject } from '@/lib/request-json';
import { parseWatcherTargetsRequest } from '@/lib/watcher-targets-request';

export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): boolean {
  const token = process.env.H2H_API_TOKEN;
  if (!token) return true; // no token configured — open (matches existing convention)
  return req.headers.get('x-api-token') === token;
}

export async function GET() {
  try {
    const tiers = await computeTiers();
    const state = await getTierState();
    return NextResponse.json({
      stats: tiers.stats,
      hotPairIds: tiers.hotPairIds,
      tierState: state,
    });
  } catch (err) {
    logger.error('[watcher-targets] GET failed', { err });
    return NextResponse.json({ error: 'Failed to compute tiers' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = await parseJsonObject(req);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const body = parseWatcherTargetsRequest(parsed.body);
  if ('error' in body) {
    return NextResponse.json({ error: body.error }, { status: 400 });
  }

  try {
    if (body.action === 'refresh') {
      const result = await refreshWatchTargets();
      return NextResponse.json({ ok: true, ...result });
    }
    if (body.action === 'promote') {
      await flagForPromotion(body.pairId);
      return NextResponse.json({ ok: true, pairId: body.pairId });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    logger.error('[watcher-targets] POST failed', { err, action: body.action });
    return NextResponse.json({ error: 'Action failed' }, { status: 500 });
  }
}
