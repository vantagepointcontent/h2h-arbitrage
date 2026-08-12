import { NextRequest, NextResponse } from 'next/server';
import { deleteManualMatch } from '@/lib/manual-matches';
import { clientSafeError } from '@/lib/error-handler';
import { parseResourceId } from '@/lib/resource-id';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawId } = await params;
    const id = parseResourceId(rawId);
    if (!id) {
      return NextResponse.json({ error: 'Missing or invalid id' }, { status: 400 });
    }
    const ok = await deleteManualMatch(id);
    return ok
      ? NextResponse.json({ success: true })
      : NextResponse.json({ error: 'Manual match not found' }, { status: 404 });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}