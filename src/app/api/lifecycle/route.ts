import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { runLifecycleSweep, previewLifecycleSweep } from '@/lib/lifecycle';
import { getArchivedMarkets, unarchiveSavedMarket, archiveSavedMarket } from '@/lib/persistence';
import { parseJsonObject } from '@/lib/request-json';
import { parseLifecycleRequest } from '@/lib/lifecycle-request';

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
  const parsed = await parseJsonObject(req);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const request = parseLifecycleRequest(parsed.body);
  if ('error' in request) return NextResponse.json({ error: request.error }, { status: 400 });

  try {
    if (request.action === 'sweep') {
      const result = await runLifecycleSweep();
      return NextResponse.json({ success: true, result });
    }

    if (request.action === 'archive') {
      const ok = await archiveSavedMarket(request.id, 'manual');
      if (!ok) return NextResponse.json({ error: 'Market not found or already archived' }, { status: 404 });
      return NextResponse.json({ success: true });
    }

    const ok = await unarchiveSavedMarket(request.id);
    if (!ok) return NextResponse.json({ error: 'Market not found or not archived' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
