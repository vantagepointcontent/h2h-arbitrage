import { NextRequest, NextResponse } from 'next/server';
import { approveReviewPair } from '@/lib/auto-discovery';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';
import { parseReviewPairId } from '@/lib/auto-discovery-request';

/**
 * POST /api/auto-discovery/approve
 *
 * Body: { pairId: string }
 *
 * Approves a pending review pair and queues it for arb scanning.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const pair = parseReviewPairId(parsed.body.pairId);
    if ('error' in pair) return NextResponse.json({ error: pair.error }, { status: 400 });

    const result = await approveReviewPair(pair.pairId);

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      approved: result.approved,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to approve review pair') },
      { status: 500 }
    );
  }
}