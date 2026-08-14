import { NextRequest, NextResponse } from 'next/server';
import { getCurrentLogRoiBatch } from '@/lib/current-log-roi.server';
import { parseJsonObject } from '@/lib/request-json';

const MAX_BATCH = 100;

export async function POST(request: NextRequest) {
  const parsed = await parseJsonObject(request);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const ids = parsed.body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH
    || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    return NextResponse.json({ error: `Expected 1-${MAX_BATCH} positive integer scan ids.` }, { status: 400 });
  }
  const valuations = await getCurrentLogRoiBatch(ids as number[]);
  return NextResponse.json({ valuations }, { headers: { 'Cache-Control': 'private, no-store' } });
}