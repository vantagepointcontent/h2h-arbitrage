import { NextRequest, NextResponse } from 'next/server';
import { getUncoupledEvents } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';

const SORT_FIELDS = new Set(['title', 'expiry', 'confidence']);
const PLATFORMS = new Set(['both', 'kalshi', 'polymarket']);

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const searchParam = searchParams.get('search');
    const search = searchParam?.trim() || undefined;
    const sortBy = searchParams.get('sortBy') || 'title';
    const platform = searchParams.get('platform') || 'both';
    const minConfidenceParam = searchParams.get('minConfidence');

    if (search && search.length > 200) {
      return NextResponse.json({ error: 'search must be at most 200 characters' }, { status: 400 });
    }
    if (!SORT_FIELDS.has(sortBy)) {
      return NextResponse.json({ error: 'Invalid sortBy. Use title, expiry, or confidence.' }, { status: 400 });
    }
    if (!PLATFORMS.has(platform)) {
      return NextResponse.json({ error: 'Invalid platform. Use both, kalshi, or polymarket.' }, { status: 400 });
    }

    let minConfidence: number | undefined;
    if (minConfidenceParam !== null) {
      minConfidence = Number(minConfidenceParam);
      if (minConfidenceParam.trim() === '' || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
        return NextResponse.json({ error: 'minConfidence must be a finite number between 0 and 1.' }, { status: 400 });
      }
    }

    const data = await getUncoupledEvents({
      search,
      sortBy: sortBy as 'title' | 'expiry' | 'confidence',
      platform: platform as 'both' | 'kalshi' | 'polymarket',
      minConfidence,
    });
    return NextResponse.json({
      markets: data.events,
      total: data.total,
    });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
