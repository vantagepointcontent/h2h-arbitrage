import { NextRequest, NextResponse } from 'next/server';
import { getDecoupledPairs, addDecoupledPair, removeDecoupledPair } from '@/lib/decoupled-pairs';

export async function GET() {
  try {
    const pairs = await getDecoupledPairs();
    return NextResponse.json({ pairs }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
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
    const pair = await addDecoupledPair({
      kalshiTicker: body.kalshiTicker,
      pmConditionId: body.pmConditionId,
      kalshiTitle: body.kalshiTitle || '',
      pmTitle: body.pmTitle || '',
    });
    return NextResponse.json({ pair }, { status: 201 });
  } catch (err: any) {
    if (err.message === 'Pair already decoupled') {
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
    const ok = await removeDecoupledPair(id);
    return NextResponse.json({ success: ok });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}