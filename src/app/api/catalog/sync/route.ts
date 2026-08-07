import { NextRequest } from 'next/server';
import { refreshMarketCatalog } from '@/lib/market-catalog';
import { matchCrossPlatformMarkets } from '@/lib/cross-platform-matcher';
import {
  createSyncRun,
  getSyncProgress,
  updateSyncProgress,
  subscribeSyncProgress,
  SyncProgress,
} from '@/lib/catalog-progress';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

function sse(progress: SyncProgress): string {
  return `data: ${JSON.stringify(progress)}\n\n`;
}

async function runSync(runId: string) {
  try {
    updateSyncProgress(runId, { step: 'fetching_kalshi', message: 'Fetching Kalshi markets...' });
    const catalogResult = await refreshMarketCatalog({
      runId,
      onProgress: (update) => updateSyncProgress(runId, update),
    });

    updateSyncProgress(runId, {
      step: 'matching',
      kalshiCount: catalogResult.kalshi.fetched,
      polymarketCount: catalogResult.polymarket.fetched,
      message: 'Matching cross-platform pairs...',
    });

    const matchResult = await matchCrossPlatformMarkets({
      maxVerifications: 500,
      onProgress: (update) => updateSyncProgress(runId, update),
    });

    updateSyncProgress(runId, {
      step: 'complete',
      candidates: matchResult.candidatesChecked,
      verified: matchResult.verifiedPairs,
      newPairs: matchResult.autoQueued + matchResult.pendingReview,
      message: `Complete — ${matchResult.verifiedPairs} new markets found`,
      finishedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    updateSyncProgress(runId, {
      step: 'error',
      error: err.message || String(err),
      message: err.message || 'Sync failed',
    });
  }
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('runId') || randomUUID();
  createSyncRun(runId);

  // Start the work in the background so we can stream immediately.
  void runSync(runId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (p: SyncProgress) => {
        controller.enqueue(encoder.encode(sse(p)));
        if (p.step === 'complete' || p.step === 'error') {
          try {
            controller.close();
          } catch {}
        }
      };

      const unsubscribe = subscribeSyncProgress(runId, send);

      request.signal.addEventListener('abort', () => {
        unsubscribe();
        try {
          controller.close();
        } catch {}
      });

      // Heartbeat to keep proxies alive
      const heartbeat = setInterval(() => {
        if (request.signal.aborted) {
          clearInterval(heartbeat);
          return;
        }
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 5000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('runId');
  if (!runId) {
    return new Response('Missing runId', { status: 400 });
  }
  const progress = getSyncProgress(runId);
  if (!progress) {
    return new Response('Run not found', { status: 404 });
  }
  return Response.json(progress);
}
