import { NextRequest, NextResponse } from 'next/server';
import { fetchClobMarkets } from '@/lib/polymarket-clob';
import { clientSafeError } from '@/lib/error-handler';

/* EXEC-002: resolve Polymarket YES/NO token IDs for a conditionId so the
 * scan page can build an ExecutableArb for the manual-execute modal. */
export async function GET(request: NextRequest) {
  try {
    const conditionId = new URL(request.url).searchParams.get('conditionId');
    if (!conditionId) {
      return NextResponse.json({ success: false, error: 'Missing conditionId' }, { status: 400 });
    }
    const clobMap = await fetchClobMarkets([conditionId]);
    const clob = clobMap.get(conditionId);
    const yes = clob?.tokens?.find((t) => t.outcome === 'Yes')?.token_id ?? null;
    const no = clob?.tokens?.find((t) => t.outcome === 'No')?.token_id ?? null;
    if (!yes || !no) {
      return NextResponse.json({ success: false, error: 'Could not resolve Yes/No tokens' }, { status: 404 });
    }
    return NextResponse.json({ success: true, yesTokenId: yes, noTokenId: no });
  } catch (err) {
    return NextResponse.json({ success: false, error: clientSafeError(err) }, { status: 500 });
  }
}
