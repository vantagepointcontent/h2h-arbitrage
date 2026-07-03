// GET /api/arb-lifecycle?days=30 — aggregate arb episode stats.
// Read-only: passes the SEC-001 middleware without a token.
import { NextRequest, NextResponse } from 'next/server';
import { getLifecycleStats } from '@/lib/arb-lifecycle';
import { clientSafeError } from '@/lib/error-handler';

export async function GET(req: NextRequest) {
  try {
    const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get('days') ?? 30)));
    const stats = await getLifecycleStats(days);
    return NextResponse.json({ days, ...stats });
  } catch (err) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to load arb lifecycle stats') },
      { status: 500 },
    );
  }
}
