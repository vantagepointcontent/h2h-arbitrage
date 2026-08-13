import { NextRequest, NextResponse } from 'next/server';
import { getScanHistoryDetail } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid scan id' }, { status: 400 });
    }
    const detail = await getScanHistoryDetail(id);
    if (!detail) return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (error: unknown) {
    return NextResponse.json({ error: clientSafeError(error, 'Failed to fetch scan detail') }, { status: 500 });
  }
}