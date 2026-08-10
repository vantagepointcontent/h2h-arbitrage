import { NextRequest, NextResponse } from 'next/server';
import { queryMarketCatalog } from '@/lib/persistence';
import { parseBoundedInteger } from '@/lib/request-query';

const CATALOG_SORT_FIELDS = new Set(['fetched_at', 'expiry_date', 'title']);
const SORT_DIRECTIONS = new Set(['asc', 'desc']);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get('platform');
  const includeStaleParam = searchParams.get('includeStale');
  const limit = parseBoundedInteger(searchParams.get('limit'), 100, 1, 1000);
  const cursor = parseBoundedInteger(searchParams.get('cursor'), 0, 0, 1_000_000);
  const sortBy = searchParams.get('sortBy') ?? 'fetched_at';
  const sortDir = searchParams.get('sortDir') ?? 'desc';

  if (platform && platform !== 'kalshi' && platform !== 'polymarket') {
    return NextResponse.json({ error: 'Invalid platform. Use kalshi or polymarket.' }, { status: 400 });
  }
  if (includeStaleParam !== null && includeStaleParam !== 'true' && includeStaleParam !== 'false') {
    return NextResponse.json({ error: 'Invalid includeStale. Use true or false.' }, { status: 400 });
  }
  if (!CATALOG_SORT_FIELDS.has(sortBy)) {
    return NextResponse.json({ error: 'Invalid sortBy. Use fetched_at, expiry_date, or title.' }, { status: 400 });
  }
  if (!SORT_DIRECTIONS.has(sortDir)) {
    return NextResponse.json({ error: 'Invalid sortDir. Use asc or desc.' }, { status: 400 });
  }

  const result = await queryMarketCatalog({
    platform: (platform ?? undefined) as 'kalshi' | 'polymarket' | undefined,
    includeStale: includeStaleParam === 'true',
    limit,
    cursor,
    sortBy: sortBy as 'fetched_at' | 'expiry_date' | 'title',
    sortDir: sortDir as 'asc' | 'desc',
  });
  return NextResponse.json(result);
}
