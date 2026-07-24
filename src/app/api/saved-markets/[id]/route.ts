import { NextRequest, NextResponse } from 'next/server';
import { deleteSavedMarket, getSavedMarketById, updateSavedMarket } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { parseSavedMarketId, parseSavedMarketPatch } from '@/lib/saved-market-request';
import { parseJsonObject } from '@/lib/request-json';

/**
 * PATCH /api/saved-markets/:id
 *
 * Partial update of a saved market. Accepts:
 *   eventTitle, expiryDate, category, kalshiUrl, polymarketUrl, platformLinks
 *
 * Returns the updated market so callers can refresh local state without
 * a second GET round-trip.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawId } = await params;
    const id = parseSavedMarketId(rawId);
    if (!id) {
      return NextResponse.json({ error: 'Missing or invalid id' }, { status: 400 });
    }

    const parsed = await parseJsonObject(request);
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const update = parseSavedMarketPatch({ ...parsed.body, id });
    if ('error' in update) {
      return NextResponse.json({ error: update.error }, { status: 400 });
    }

    const { id: _, ...changes } = update;

    const ok = await updateSavedMarket(id, {
      eventTitle: changes.eventTitle,
      expiryDate: changes.expiryDate,
      category: changes.category,
      kalshiUrl: changes.kalshiUrl,
      polymarketUrl: changes.polymarketUrl,
      platformLinks: changes.platformLinks,
    });

    if (!ok) {
      return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    }

    const market = await getSavedMarketById(id);
    if (!market) {
      // Shouldn't happen after a successful update, but guard anyway
      return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, market });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawId } = await params;
    const id = parseSavedMarketId(rawId);
    if (!id) {
      return NextResponse.json({ error: 'Missing or invalid id' }, { status: 400 });
    }
    const ok = await deleteSavedMarket(id);
    return NextResponse.json({ success: ok });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
