import { NextRequest, NextResponse } from 'next/server';
import { deleteSavedMarket } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { parseSavedMarketId } from '@/lib/saved-market-request';

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