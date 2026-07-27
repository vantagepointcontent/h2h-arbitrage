import { NextRequest, NextResponse } from 'next/server';
import { getPhantomEpisodes } from '@/lib/arb-lifecycle';
import { clientSafeError } from '@/lib/error-handler';
import { parseBoundedInteger, parseOptionalBoundedText } from '@/lib/request-query';

export async function GET(req: NextRequest) {
  try {
    const days = parseBoundedInteger(req.nextUrl.searchParams.get('days'), 30, 1, 365);
    const category = parseOptionalBoundedText(req.nextUrl.searchParams.get('category'));
    return NextResponse.json({ days, episodes: await getPhantomEpisodes(days, category) });
  } catch (error) {
    return NextResponse.json({ error: clientSafeError(error, 'Failed to load phantom episodes') }, { status: 500 });
  }
}