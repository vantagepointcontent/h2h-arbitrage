import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { approveMatchedPair } from '@/lib/persistence';

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

    const outcome = await approveMatchedPair(pairId);
    if (!outcome.approved) {
      return NextResponse.json({ error: outcome.error || 'Approval failed' }, { status: 400 });
    }

    return NextResponse.json({ success: true, market: outcome.market });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
