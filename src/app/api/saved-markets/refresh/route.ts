import { NextRequest, NextResponse } from 'next/server';
import { startRefreshJob, getRefreshStatus } from '@/lib/refresh-job';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';
import { parseRefreshStartRequest } from '@/lib/refresh-request';

export async function GET(request: NextRequest) {
  try {
    const status = await getRefreshStatus();
    return NextResponse.json({ status }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: any) {
    console.error('[saved-markets-refresh-error]', err);
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to refresh saved markets') },
      { status: 500 }
    );
  }
}

/** POST /api/saved-markets/refresh — start a token-protected refresh job. */
export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const input = parseRefreshStartRequest(parsed.body);
    if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
    const status = await startRefreshJob(input.ids);
    return NextResponse.json({ started: !!status, status }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' },
    });
  } catch (err: any) {
    console.error('[saved-markets-refresh-start-error]', err);
    return NextResponse.json({ error: clientSafeError(err, 'Failed to start refresh job') }, { status: 500 });
  }
}
