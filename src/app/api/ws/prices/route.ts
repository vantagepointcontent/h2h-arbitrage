// Server-Sent Events endpoint for real-time CLOB price streaming
// GET /api/ws/prices — streams price updates via SSE
// Accepts ?tokenIds=comma-separated-list to filter updates

import { NextRequest, NextResponse } from 'next/server';
import { clobWs, WsPriceUpdate } from '@/lib/clob-ws';

const KEEPALIVE_INTERVAL_MS = 3000;

export async function GET(request: NextRequest) {
  const tokenIdsParam = request.nextUrl.searchParams.get('tokenIds');
  const requestedTokenIds = tokenIdsParam
    ? new Set(tokenIdsParam.split(','))
    : null;

  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controllerRef = ctrl;

      // Ensure the WebSocket service is connected
      if (!clobWs.isConnected()) {
        clobWs.connect();
      }

      // Determine which token IDs to subscribe to
      const tokenIds: string[] = requestedTokenIds ? [...requestedTokenIds] : [];

      // Callback: enqueue SSE messages for matching updates
      const callback = (updates: WsPriceUpdate[]) => {
        if (!controllerRef) return;
        const relevant = requestedTokenIds
          ? updates.filter((u) => requestedTokenIds.has(u.tokenId))
          : updates;

        for (const u of relevant) {
          const line = `data: ${JSON.stringify(u)}\n\n`;
          controllerRef.enqueue(encoder.encode(line));
        }
      };

      // Subscribe to WS updates
      const subKey = `sse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      clobWs.subscribe(tokenIds, callback, subKey);

      // Send initial connection event
      const connMsg = `event: connected\ndata: {"connected":true,"wsConnected":${clobWs.isConnected()},"subscribers":${clobWs.getSubscriberCount()}}\n\n`;
      ctrl.enqueue(encoder.encode(connMsg));

      // Periodic keepalive — SSE clients time out idle connections
      const keepalive = setInterval(() => {
        if (controllerRef) {
          controllerRef.enqueue(encoder.encode(': keepalive\n\n'));
        }
      }, KEEPALIVE_INTERVAL_MS);

      // Cleanup on close
      const cleanup = () => {
        clearInterval(keepalive);
        clobWs.unsubscribe(subKey);
      };

      request.signal.addEventListener('abort', cleanup);
      // Store on controller for cancel callback
      (ctrl as any)._cleanup = cleanup;
    },

    cancel() {
      (controllerRef as any)?._cleanup?.();
    },
  });

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
