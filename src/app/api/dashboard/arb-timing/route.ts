import { NextRequest, NextResponse } from 'next/server';
import { getArbTimingHeatmap } from '@/lib/arb-lifecycle';
import { clientSafeError } from '@/lib/error-handler';
import { parseBoundedInteger } from '@/lib/request-query';
import type { TimingZone } from '@/lib/arb-timing';

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const days = parseBoundedInteger(params.get('days'), 30, 1, 365);
    const category = params.get('category')?.trim() || undefined;
    const requestedZone = params.get('timeZone');
    const timeZone: TimingZone = requestedZone === 'UTC' ? 'UTC' : 'America/New_York';
    const heatmap = await getArbTimingHeatmap(days, category, timeZone);
    return NextResponse.json({ days, category: category ?? null, timeZone, ...heatmap });
  } catch (error) {
    return NextResponse.json(
      { error: clientSafeError(error, 'Failed to load arb timing heatmap') },
      { status: 500 },
    );
  }
}
