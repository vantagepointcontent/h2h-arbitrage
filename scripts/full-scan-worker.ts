import { NextRequest } from 'next/server';
import { executeFullScan } from '../src/app/api/scan/scan-execution';
import { captureAndPersistRateLimiterMetrics } from '../src/lib/rate-limiter-capture';
import { persistRateLimiterMetrics } from '../src/lib/persistence';
import { rateLimiters, snapshotRateLimiterMetrics } from '../src/lib/rate-limiter';

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
  process.send(message, () => {
    process.disconnect?.();
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
    try {
      await captureAndPersistRateLimiterMetrics({
        serviceIdentity: 'full-scan-worker',
        snapshot: snapshotRateLimiterMetrics,
        persist: persistRateLimiterMetrics,
        resetters: Object.values(rateLimiters).map((limiter) => () => limiter.resetMetrics()),
      });
    } catch (error) {
      console.error('[full-scan-worker] capacity telemetry persistence failed', error);
    }
    publishAndExit({ type: 'result', jobId: message.jobId, response: await serializeResponse(response) }, 0);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    publishAndExit({ type: 'error', jobId: message.jobId, error: text }, 1);
  }
});
