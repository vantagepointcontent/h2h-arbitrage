import { NextRequest, NextResponse } from 'next/server';
import { getUncoupledEvents } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') || undefined;
    const sortBy = (searchParams.get('sortBy') as 'title' | 'expiry' | 'confidence') || 'title';
    const platform = (searchParams.get('platform') as 'both' | 'kalshi' | 'polymarket') || 'both';
    const minConfidence = searchParams.has('minConfidence')
      ? Number(searchParams.get('minConfidence'))
      : undefined;

    const data = await getUncoupledEvents({ search, sortBy, platform, minConfidence });
    return NextResponse.json({
      markets: data.events,
      total: data.total,
    });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
