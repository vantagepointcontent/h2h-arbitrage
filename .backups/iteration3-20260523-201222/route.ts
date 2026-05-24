import { NextRequest, NextResponse } from 'next/server';
import { getSavedMarkets, addSavedMarket, deleteSavedMarket, updateSavedMarket } from '@/lib/persistence';

export async function GET() {
  try {
    const markets = await getSavedMarkets();
    return NextResponse.json({ markets }, {
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
    if (!body.kalshiUrl || !body.polymarketUrl) {
      return NextResponse.json({ error: 'Missing kalshiUrl or polymarketUrl' }, { status: 400 });
    }
    const market = await addSavedMarket({
      kalshiUrl: body.kalshiUrl,
      polymarketUrl: body.polymarketUrl,
      eventTitle: body.eventTitle || 'Untitled',
      expiryDate: body.expiryDate || null,
    });
    return NextResponse.json({ market }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }
    const ok = await updateSavedMarket(body.id, {
      eventTitle: body.eventTitle,
      expiryDate: body.expiryDate,
    });
    if (!ok) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err: any) {
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
    const ok = await deleteSavedMarket(id);
    return NextResponse.json({ success: ok });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
