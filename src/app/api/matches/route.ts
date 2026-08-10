import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { getMatchedPairs, type MatchedPair } from '@/lib/persistence';
import { matchCrossPlatformMarkets } from '@/lib/cross-platform-matcher';
import { parseBoundedInteger } from '@/lib/request-query';

const MATCH_STATUSES = new Set<MatchedPair['status']>([
  'auto_queued',
  'pending_review',
  'approved',
  'rejected',
]);

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    const limit = parseBoundedInteger(searchParams.get('limit'), 200, 1, 1000);

    let status: MatchedPair['status'] | MatchedPair['status'][] | undefined;
    if (statusParam) {
      const statuses = statusParam.split(',');
      if (statuses.some(value => !MATCH_STATUSES.has(value as MatchedPair['status']))) {
        return NextResponse.json(
          { error: 'Invalid status. Use auto_queued, pending_review, approved, or rejected.' },
          { status: 400 },
        );
      }
      status = statuses.length === 1
        ? statuses[0] as MatchedPair['status']
        : statuses as MatchedPair['status'][];
    }

    const pairs = await getMatchedPairs(status, limit);
    return NextResponse.json({ pairs });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.action !== 'run') {
      return NextResponse.json({ error: 'Invalid action. Use "run".' }, { status: 400 });
    }

    const result = await matchCrossPlatformMarkets({
      candidateThreshold: body.candidateThreshold,
      maxVerifications: body.maxVerifications,
      maxExpiryDays: body.maxExpiryDays,
      autoQueueThreshold: body.autoQueueThreshold,
      reviewThreshold: body.reviewThreshold,
    });

    return NextResponse.json({ result });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
