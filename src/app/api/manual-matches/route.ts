import { NextRequest, NextResponse } from 'next/server';
import { getManualMatches, addManualMatch, deleteManualMatch, ManualMatch } from '@/lib/manual-matches';

export async function GET() {
  try {
    const matches = await getManualMatches();
    return NextResponse.json({ matches }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      }
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.kalshiTicker || !body.pmConditionId) {
      return NextResponse.json({ error: 'Missing kalshiTicker or pmConditionId' }, { status: 400 });
    }
    const match = await addManualMatch({
      kalshiTicker: body.kalshiTicker,
      pmConditionId: body.pmConditionId,
      kalshiTitle: body.kalshiTitle || '',
      pmTitle: body.pmTitle || '',
      kalshiUrl: body.kalshiUrl,
      polymarketUrl: body.polymarketUrl,
    });
    return NextResponse.json({ match }, { status: 201 });
  } catch (err: any) {
    if (err.message === 'Manual match already exists for this pair') {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing id query parameter' }, { status: 400 });
    }
    const ok = await deleteManualMatch(id);
    return NextResponse.json({ success: ok });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
