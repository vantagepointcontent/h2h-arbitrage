import { NextRequest, NextResponse } from 'next/server';
import { getPendingReviewPairs } from '@/lib/auto-discovery';

/** GET /api/auto-discovery/pending — Returns pairs awaiting manual review. */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const pending = getPendingReviewPairs();
    return NextResponse.json({
      success: true,
      count: pending.length,
      pairs: pending,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to load pending review pairs' },
      { status: 500 },
    );
  }
}
