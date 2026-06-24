import { NextRequest, NextResponse } from 'next/server';
import { startRefreshJob, getRefreshStatus } from '@/lib/refresh-job';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // If ?start=true, kick off background refresh and return immediately
    if (searchParams.get('start') === 'true') {
      const idsParam = searchParams.get('ids');
      const marketIds = idsParam ? idsParam.split(',').filter(Boolean) : undefined;
      const status = await startRefreshJob(marketIds);
      return NextResponse.json({ started: !!status, status }, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        },
      });
    }

    // Otherwise return current status
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
      { error: err.message || 'Failed to refresh saved markets' },
      { status: 500 }
    );
  }
}
