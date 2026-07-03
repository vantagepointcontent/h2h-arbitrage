// WS-106: Lightweight read-only tier-state endpoint for UI badges.
// Unlike GET /api/watcher/targets (which runs the full computeTiers pass and
// writes tier state), this just reads watch_tier_state — cheap enough for the
// sidebar to poll.

import { NextResponse } from 'next/server';
import { getTierState } from '@/lib/watch-targets';
import logger from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const state = await getTierState();
    const hotPairIds = state.filter((s) => s.tier === 'hot').map((s) => s.pairId);
    return NextResponse.json({ tierState: state, hotPairIds });
  } catch (err) {
    logger.error('[watcher-tiers] GET failed', { err });
    return NextResponse.json({ tierState: [], hotPairIds: [], error: 'Failed to read tier state' }, { status: 200 });
  }
}
