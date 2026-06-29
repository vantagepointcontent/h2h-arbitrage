import { NextRequest, NextResponse } from 'next/server';
import { approveReviewPair } from '@/lib/auto-discovery';

/**
 * POST /api/auto-discovery/approve
 *
 * Body: { pairId: string }
 *
 * Approves a pending review pair and queues it for arb scanning.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { pairId } = body;

    if (!pairId || typeof pairId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid pairId' },
        { status: 400 }
      );
    }

    const result = await approveReviewPair(pairId);

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      approved: result.approved,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to approve review pair' },
      { status: 500 }
    );
  }
}