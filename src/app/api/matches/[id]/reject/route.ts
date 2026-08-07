import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { rejectMatchedPair } from '@/lib/persistence';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const pairId = parseInt(id, 10);
    if (Number.isNaN(pairId)) {
      return NextResponse.json({ error: 'Invalid pair id' }, { status: 400 });
    }

    const ok = await rejectMatchedPair(pairId);
    if (!ok) {
      return NextResponse.json({ error: 'Pair not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
