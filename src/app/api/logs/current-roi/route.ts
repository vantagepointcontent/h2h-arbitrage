import { NextRequest, NextResponse } from 'next/server';
import { getCurrentLogRoiBatch } from '@/lib/current-log-roi.server';
import { parseJsonObject } from '@/lib/request-json';

const MAX_BATCH = 100;

function validIds(ids: unknown): ids is number[] {
  return Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_BATCH
    && ids.every((id) => Number.isInteger(id) && id > 0);
}

async function responseFor(ids: unknown) {
  if (!validIds(ids)) {
    return NextResponse.json({ error: `Expected 1-${MAX_BATCH} positive integer scan ids.` }, { status: 400 });
  }
  const valuations = await getCurrentLogRoiBatch(ids);
  return NextResponse.json({ valuations }, { headers: { 'Cache-Control': 'private, no-store' } });
}

/** Read-only browser batch. GET deliberately avoids the mutation-auth middleware. */
export async function GET(request: NextRequest) {
  const raw = new URL(request.url).searchParams.get('ids');
  const ids = raw ? raw.split(',').map((value) => Number(value)) : [];
  return responseFor(ids);
}

export async function POST(request: NextRequest) {
  const parsed = await parseJsonObject(request);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return responseFor(parsed.body.ids);
}