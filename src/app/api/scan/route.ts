import { NextRequest, NextResponse } from 'next/server';
import { getScanClientKey, isTrustedScheduledScan, scanRateLimiter } from '@/lib/scan-rate-limit';
import { scanWorkerCoordinator, ScanWorkerError } from '@/lib/scan-worker-coordinator';
import { resolveScanLinks } from '@/lib/scan-links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function marketJobKey(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const { kalshiUrl, polymarketUrl } = resolveScanLinks(parsed);
    if (!kalshiUrl || !polymarketUrl) return null;
    return `${kalshiUrl.trim().toLowerCase()}|${polymarketUrl.trim().toLowerCase()}`;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const scheduledScan = isTrustedScheduledScan(request.headers, process.env.H2H_API_TOKEN);
  const rateLimit = scheduledScan ? null : scanRateLimiter.consume(getScanClientKey(request.headers));
  if (rateLimit && !rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many scan requests. Please retry shortly.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(rateLimit.retryAfterSeconds),
          'X-RateLimit-Remaining': '0',
        },
      },
    );
  }

  const body = await request.text();
  const marketKey = marketJobKey(body) ?? 'invalid';
  // Exact duplicates share work. A request for the same market with different
  // capital/manual-mode inputs must not inherit another request's result.
  const key = `${marketKey}|${body}`;
  try {
    const result = await scanWorkerCoordinator.run(key, {
      body,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
    }, request.signal);
    return new NextResponse(result.body, {
      status: result.status,
      headers: {
        ...result.headers,
        'X-Scan-Job-Id': result.jobId ?? '',
        'X-Scan-Deduplicated': result.deduplicated ? '1' : '0',
      },
    });
  } catch (error) {
    if (error instanceof ScanWorkerError) {
      if (error.code === 'SCAN_CAPACITY') {
        return NextResponse.json(
          { error: 'Scanner is at capacity. Please retry shortly.' },
          { status: 503, headers: { 'Retry-After': '2' } },
        );
      }
      if (error.code === 'SCAN_TIMEOUT') {
        return NextResponse.json({ error: error.message }, { status: 504 });
      }
      if (error.code === 'SCAN_CANCELLED') {
        return NextResponse.json({ error: error.message }, { status: 499 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }
}
