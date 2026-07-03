import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { runLifecycleSweep, previewLifecycleSweep } from '@/lib/lifecycle';
import { getArchivedMarkets, unarchiveSavedMarket, archiveSavedMarket } from '@/lib/persistence';

/**
 * AUTO-002: Market lifecycle API.
 *
 * GET  /api/lifecycle              — archived markets + dry-run preview of next sweep
 * POST /api/lifecycle              — { action: 'sweep' }                  run sweep now
 *                                    { action: 'archive', id }           manual archive
 *                                    { action: 'unarchive', id }         restore market
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const [archived, preview] = await Promise.all([
      getArchivedMarkets(),
      previewLifecycleSweep(),
    ]);
    return NextResponse.json({ archived, preview });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const action = body?.action;

    if (action === 'sweep') {
      const result = await runLifecycleSweep();
      return NextResponse.json({ success: true, result });
    }

    if (action === 'archive') {
      if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
      const ok = await archiveSavedMarket(String(body.id), 'manual');
      if (!ok) return NextResponse.json({ error: 'Market not found or already archived' }, { status: 404 });
      return NextResponse.json({ success: true });
    }

    if (action === 'unarchive') {
      if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
      const ok = await unarchiveSavedMarket(String(body.id));
      if (!ok) return NextResponse.json({ error: 'Market not found or not archived' }, { status: 404 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json(
      { error: 'Invalid action. Use "sweep", "archive", or "unarchive".' },
      { status: 400 },
    );
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
