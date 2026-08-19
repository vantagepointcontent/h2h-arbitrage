import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { getCanonicalSavedMarketsBasicSnapshot } from '@/lib/saved-markets-list';

function authorized(request: NextRequest): boolean {
  const token = process.env.H2H_API_TOKEN;
  return !token || request.headers.get('x-h2h-token') === token;
}

/** Protected persistence-only list refresh. This route never contacts a venue. */
export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const snapshot = await getCanonicalSavedMarketsBasicSnapshot();
    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'ETag': `"${snapshot.revision}"`,
      },
    });
  } catch (error) {
    console.error('[saved-markets-list-refresh-error]', clientSafeError(error, 'Saved markets are unavailable'));
    return NextResponse.json({ error: 'Saved markets are temporarily unavailable.' }, { status: 503 });
  }
}
