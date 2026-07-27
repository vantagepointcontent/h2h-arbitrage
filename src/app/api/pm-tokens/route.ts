import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { parsePolymarketConditionId } from '@/lib/polymarket-request';

/* EXEC-002: resolve Polymarket YES/NO token IDs for a conditionId so the
 * scan page can build an ExecutableArb for the manual-execute modal.
 *
 * BUG-FIX: Previously used fetchClobMarkets() which goes through the shared
 * rate limiter + semaphore. When the poller saturates the semaphore with
 * concurrent CLOB requests, pm-tokens hangs indefinitely. Now fetches
 * directly from the CLOB API with its own timeout, bypassing the shared
 * rate limiter entirely. This is safe because pm-tokens is called rarely
 * (only on manual Execute button click), not in a polling burst. */
export async function GET(request: NextRequest) {
  try {
    const parsed = parsePolymarketConditionId(new URL(request.url).searchParams.get('conditionId'));
    if ('error' in parsed) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    const conditionId = parsed.conditionId;

    // Direct CLOB API call — no shared rate limiter, no semaphore
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(
        `https://clob.polymarket.com/markets/${conditionId}?_t=${Date.now()}`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'h2h-arbitrage/1.0',
          },
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      clearTimeout(timer);
      if (!res.ok) {
        return NextResponse.json({ success: false, error: `CLOB API HTTP ${res.status}` }, { status: 502 });
      }
      const data = await res.json();
      const tokens = data?.tokens;
      if (!Array.isArray(tokens)) {
        return NextResponse.json({ success: false, error: 'Invalid CLOB token response' }, { status: 502 });
      }
      const yes = tokens.find((t: { outcome?: string }) => t.outcome === 'Yes')?.token_id ?? null;
      const no = tokens.find((t: { outcome?: string }) => t.outcome === 'No')?.token_id ?? null;
      if (!yes || !no) {
        return NextResponse.json({ success: false, error: 'Could not resolve Yes/No tokens' }, { status: 404 });
      }
      return NextResponse.json({ success: true, yesTokenId: yes, noTokenId: no });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return NextResponse.json({ success: false, error: clientSafeError(err) }, { status: 500 });
  }
}
