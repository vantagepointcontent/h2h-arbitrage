import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { getMatchedPairs } from '@/lib/persistence';
import { matchCrossPlatformMarkets } from '@/lib/cross-platform-matcher';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '200', 10);

    let status = statusParam ? (statusParam.split(',') as any) : undefined;
    if (Array.isArray(status) && status.length === 1) status = status[0];

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
