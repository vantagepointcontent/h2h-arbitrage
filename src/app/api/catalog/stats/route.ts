import { NextRequest, NextResponse } from 'next/server';
import { getMarketCatalogStats } from '@/lib/persistence';

export async function GET(_request: NextRequest) {
  const stats = await getMarketCatalogStats();
  return NextResponse.json(stats);
}
