import { NextRequest } from 'next/server';
import { executeFullScan } from '../src/app/api/scan/scan-execution';
import { buildRateLimiterMetricRecords } from '../src/lib/rate-limiter-capture';
import { rateLimiters, snapshotRateLimiterMetrics } from '../src/lib/rate-limiter';
import { getSqliteContentionMetrics } from '../src/lib/sqlite-write-retry';

interface RunMessage {
  type: 'run';
  jobId: string;
  request: {
    body: string;
    url?: string;
    headers?: Record<string, string>;
  };
}

async function serializeResponse(response: Response) {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

let started = false;
function publishAndExit(message: unknown, exitCode: number): void {
  if (!process.send) {
    process.exit(exitCode);
  }
  const fallback = setTimeout(() => process.exit(exitCode), 5_000);
  process.send(message, (error) => {
    if (!error) return;
    clearTimeout(fallback);
    process.exit(exitCode);
  });
}

process.on('message', async (message: RunMessage) => {
  if (started || message?.type !== 'run') return;
  started = true;
  try {
    const request = new NextRequest(message.request.url || 'http://localhost/api/scan', {
      method: 'POST',
      headers: message.request.headers,
      body: message.request.body,
    });
    const response = await executeFullScan(request);
    const telemetry = buildRateLimiterMetricRecords('full-scan-worker', snapshotRateLimiterMetrics());
    for (const limiter of Object.values(rateLimiters)) limiter.resetMetrics();
    publishAndExit({
      type: 'result',
      jobId: message.jobId,
      response: await serializeResponse(response),
      telemetry,
      sqliteContention: getSqliteContentionMetrics(),
    }, 0);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    publishAndExit({ type: 'error', jobId: message.jobId, error: text, sqliteContention: getSqliteContentionMetrics() }, 1);
  }
});
