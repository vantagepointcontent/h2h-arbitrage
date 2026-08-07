import { NextRequest, NextResponse } from 'next/server';
import { quickPricesScan, QuickPricesResult } from '@/lib/quick-prices';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';
import { parseScanCapital } from '@/lib/scan-request';
import { scanRateLimiter, getScanClientKey } from '@/lib/scan-rate-limit';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rateLimit = scanRateLimiter.consume(getScanClientKey(request.headers));
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many quick-prices requests. Please retry shortly.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(rateLimit.retryAfterSeconds),
          'X-RateLimit-Remaining': '0',
        },
      },
    );
  }

  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const body = parsed.body;

    const marketId = typeof body.marketId === 'string' ? body.marketId : null;
    if (!marketId) {
      return NextResponse.json({ error: 'Missing marketId.' }, { status: 400 });
    }

    const capital = parseScanCapital(body.capital);
    if (capital === null) {
      return NextResponse.json(
        { error: 'Invalid capital. Expected a finite number from $1 to $1,000,000.' },
        { status: 400 },
      );
    }

    const result: QuickPricesResult = await quickPricesScan(marketId, capital);
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (err: any) {
    const msg = clientSafeError(err, 'Unknown error');
    const status = err?.status || (msg.includes('timed out') ? 504 : msg.includes('not found') ? 404 : 500);
    return NextResponse.json({ error: msg }, { status });
  }
}
