import { NextRequest, NextResponse } from 'next/server';
import { getCurrentLogRoiBatch } from '@/lib/current-log-roi.server';
import { parseJsonObject } from '@/lib/request-json';
import { consumeCurrentRoiGlobalRateLimit } from '@/lib/current-roi-rate-limit';

const MAX_BATCH = 25;

export async function POST(request: NextRequest) {
  const rateLimit = consumeCurrentRoiGlobalRateLimit();
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many current-ROI requests. Please retry shortly.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds), 'X-RateLimit-Remaining': '0' } },
    );
  }
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