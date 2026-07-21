import { NextRequest, NextResponse } from 'next/server';
import { getDecoupledPairs, addDecoupledPair, removeDecoupledPair } from '@/lib/decoupled-pairs';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';
import { parseDecoupledPairCreateRequest, parseDecoupledPairId } from '@/lib/decoupled-pairs-request';

export async function GET() {
  try {
    const pairs = await getDecoupledPairs();
    return NextResponse.json({ pairs }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const body = parseDecoupledPairCreateRequest(parsed.body);
    if ('error' in body) return NextResponse.json({ error: body.error }, { status: 400 });
    const pair = await addDecoupledPair(body);
    return NextResponse.json({ pair }, { status: 201 });
  } catch (err: any) {
    if (err.message === 'Pair already decoupled') {
      return NextResponse.json({ error: clientSafeError(err) }, { status: 409 });
    }
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = parseDecoupledPairId(searchParams.get('id'));
    if (typeof id !== 'string') return NextResponse.json({ error: id.error }, { status: 400 });
    const ok = await removeDecoupledPair(id);
    return NextResponse.json({ success: ok });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}