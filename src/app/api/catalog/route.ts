import { NextRequest, NextResponse } from 'next/server';
import { queryMarketCatalog } from '@/lib/persistence';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get('platform') as 'kalshi' | 'polymarket' | null;
  const includeStale = searchParams.get('includeStale') === 'true';
  const limit = Number(searchParams.get('limit') ?? '100');
  const cursor = Number(searchParams.get('cursor') ?? '0');
  const sortBy = (searchParams.get('sortBy') ?? 'fetched_at') as 'fetched_at' | 'expiry_date' | 'title';
  const sortDir = (searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc';

  if (platform && platform !== 'kalshi' && platform !== 'polymarket') {
    return NextResponse.json({ error: 'Invalid platform. Use kalshi or polymarket.' }, { status: 400 });
  }

  const result = await queryMarketCatalog({
    platform: platform ?? undefined,
    includeStale,
    limit,
    cursor,
    sortBy,
    sortDir,
  });
  return NextResponse.json(result);
}
