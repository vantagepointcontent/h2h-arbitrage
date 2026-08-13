import { NextRequest, NextResponse } from 'next/server';
import { quickPricesScan, QuickPricesResult } from '@/lib/quick-prices';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';
import { parseScanCapital } from '@/lib/scan-request';
import { scanRateLimiter, getScanClientKey } from '@/lib/scan-rate-limit';
import { correlationId, CORRELATION_ID_HEADER } from '@/lib/correlation';
import { reconcileSavedMarketMatchSummary, reserveSavedMarketPublication } from '@/lib/persistence';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestCorrelationId = request.headers.get(CORRELATION_ID_HEADER) || correlationId.generate();
  return correlationId.run(requestCorrelationId, async () => {
    const response = await handlePost(request);
    response.headers.set(CORRELATION_ID_HEADER, requestCorrelationId);
    return response;
  });
}

async function handlePost(request: NextRequest): Promise<NextResponse> {
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

  let marketId: string | null = null;
  let publicationGeneration: number | null = null;
  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const body = parsed.body;

    marketId = typeof body.marketId === 'string' ? body.marketId : null;
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

    publicationGeneration = await reserveSavedMarketPublication(marketId, 'scan');
    await reconcileSavedMarketMatchSummary(marketId, {
      matchedCount: 0,
      matchStatus: 'refreshing',
      matchError: undefined,
      matchedPairs: undefined,
      scannedAt: new Date().toISOString(),
      publicationGeneration,
    });
    const result: QuickPricesResult = await quickPricesScan(marketId, capital);
    await reconcileSavedMarketMatchSummary(marketId, {
      matchedCount: result.matchedCount,
      matchStatus: result.matchStatus,
      matchError: result.matchError,
      matchedPairs: result.matchedPairs,
      scannedAt: result._pmFetchedAt,
      publicationGeneration,
    });
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (err: unknown) {
    const errorStatus = typeof err === 'object' && err !== null && 'status' in err
      && typeof err.status === 'number' ? err.status : null;
    const errorMessage = err instanceof Error ? err.message : '';
    const fallback = errorStatus === 404
      ? 'Saved market not found. It may have been removed; return to Markets and select it again.'
      : errorStatus === 400 && errorMessage === 'A valid Kalshi market link is required.'
        ? 'Saved market has an invalid Kalshi link. Return to Markets and update or re-add this saved market.'
        : errorStatus === 400 && errorMessage === 'A valid Polymarket market link is required.'
          ? 'Saved market has an invalid Polymarket link. Return to Markets and update or re-add this saved market.'
          : 'Saved-market price refresh failed';
    const msg = clientSafeError(err, fallback, { path: '/api/quick-prices' });
    const status = errorStatus || (msg.includes('timed out') ? 504 : 500);
    if (marketId && publicationGeneration != null) {
      await reconcileSavedMarketMatchSummary(marketId, {
        matchedCount: 0,
        matchStatus: 'unavailable',
        matchError: msg,
        matchedPairs: undefined,
        scannedAt: new Date().toISOString(),
        publicationGeneration,
      }).catch(() => {});
    }
    return NextResponse.json({ error: msg }, { status });
  }
}
