// GET /api/arb-episodes/active?marketId={id}&outcome={outcome}
// UI-09: Returns active episode ROI time series for a market (or specific
// outcome if provided). Read-only — passes SEC-001 middleware without a token.
import { NextRequest, NextResponse } from 'next/server';
import { getActiveEpisodeDecay, getActiveEpisodesForMarket } from '@/lib/arb-lifecycle';
import { clientSafeError } from '@/lib/error-handler';

export async function GET(req: NextRequest) {
  try {
    const marketId = req.nextUrl.searchParams.get('marketId');
    if (!marketId) {
      return NextResponse.json({ error: 'marketId is required' }, { status: 400 });
    }

    const outcome = req.nextUrl.searchParams.get('outcome');

    if (outcome) {
      // Single outcome
      const decay = await getActiveEpisodeDecay(marketId, outcome);
      return NextResponse.json({ episodes: decay ? [decay] : [] });
    }

    // All active episodes for the market
    const episodes = await getActiveEpisodesForMarket(marketId);
    return NextResponse.json({ episodes });
  } catch (err) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to load active episodes') },
      { status: 500 },
    );
  }
}