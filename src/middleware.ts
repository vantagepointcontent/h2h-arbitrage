import { NextRequest, NextResponse } from 'next/server';
import { correlationId, CORRELATION_ID_HEADER } from '@/lib/correlation';

/**
 * Next.js middleware — runs on every request before it reaches a route handler.
 *
 * Responsibilities:
 *   1. Extract or generate a correlation ID for distributed tracing
 *   2. Bind it to AsyncLocalStorage so logger picks it up automatically
 *   3. Attach it to the outgoing response header for end-to-end tracing
 */
export function middleware(request: NextRequest) {
  const incomingId = request.headers.get(CORRELATION_ID_HEADER) ?? undefined;
  const id = incomingId ?? correlationId.generate();

  // Store in async local storage for the request lifecycle
  // We wrap the response creation so logger corrlationId.current picks it up
  const response = correlationId.run(id, () => {
    return NextResponse.next();
  });

  // Echo the correlation ID on every response for downstream services
  response.headers.set(CORRELATION_ID_HEADER, id);

  return response;
}

// Match all API routes and static assets, skip Next.js internals
export const config = {
  matcher: ['/api/:path*', '/healthz', '/metrics'],
};
