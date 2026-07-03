import { NextRequest, NextResponse } from 'next/server';
import logger, { errorFingerprint, fingerprintHash } from './logger';
import { correlationId, CORRELATION_ID_HEADER } from './correlation';
import { spikeDetector } from './spike-alert';

// ---------------------------------------------------------------------------
// Typed error envelope for structured error responses
// ---------------------------------------------------------------------------

export interface ErrorEnvelope {
  error: string;
  code?: string;
  correlationId?: string;
  fingerprint?: string;
}

// ---------------------------------------------------------------------------
// HTTP error codes mapped from common error shapes
// ---------------------------------------------------------------------------

export function errorToStatus(error: unknown): number {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) return 504;
    if (msg.includes('not found') || msg.includes('enoent')) return 404;
    if (msg.includes('invalid') || msg.includes('bad request') || msg.includes('validation')) return 400;
    if (msg.includes('unauthorized') || msg.includes('auth')) return 401;
    if (msg.includes('forbidden') || msg.includes('permission')) return 403;
    if (msg.includes('conflict') || msg.includes('already')) return 409;
  }
  return 500;
}

// ---------------------------------------------------------------------------
// Central error handler for Next.js route handlers
// ---------------------------------------------------------------------------

export function handleError(error: unknown, context?: { service?: string; path?: string }): ErrorEnvelope {
  const fp = errorFingerprint(error);
  const msg = error instanceof Error ? error.message : String(error);
  const status = errorToStatus(error);
  const cid = correlationId.current;

  // Track in spike detector
  spikeDetector.record({ fingerprint: fp, message: msg });

  // Log with full context
  logger.error(msg, {
    error,
    fingerprint: fp,
    fingerprintHash: fingerprintHash(fp),
    status,
    service: context?.service ?? 'h2h-arbitrage',
    path: context?.path,
    correlationId: cid,
  });

  return {
    error: msg,
    code: error instanceof Error ? error.constructor.name : 'Error',
    correlationId: cid,
    fingerprint: fp,
  };
}

// ---------------------------------------------------------------------------
// Helper: send a standardized JSON error response
// ---------------------------------------------------------------------------

export function errorResponse(
  error: unknown,
  ctx?: { service?: string; path?: string },
): NextResponse {
  const envelope = handleError(error, ctx);
  const status = errorToStatus(error);

  return NextResponse.json(envelope, {
    status,
    headers: {
      [CORRELATION_ID_HEADER]: correlationId.current ?? '',
      'X-Error-Fingerprint': envelope.fingerprint,
    } as Record<string, string>,
  });
}

// ---------------------------------------------------------------------------
// Wrap a route handler function with automatic error handling + correlation
// ---------------------------------------------------------------------------

export function withErrorHandler<TArgs extends [...unknown[]], TReturn>(
  handler: (...args: TArgs) => Promise<TReturn>,
  ctx?: { service?: string; path?: string },
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const id = correlationId.current ?? correlationId.generate();
    return correlationId.run(id, async () => {
      try {
        return await handler(...args);
      } catch (error) {
        return errorResponse(error, ctx) as unknown as TReturn;
      }
    }) as unknown as Promise<TReturn>;
  };
}

// ---------------------------------------------------------------------------
// Request timing helper — attach duration to logger
// ---------------------------------------------------------------------------

export interface TimedRequest {
  startTime: number;
  durationMs(): number;
}

export function startTimer(): TimedRequest {
  const start = Date.now();
  return {
    startTime: start,
    durationMs: () => Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// SEC-002: client-safe error messages
// Logs the FULL error server-side (message, stack, fingerprint) but returns
// only a generic, user-facing string to the client, so internal details
// (upstream API errors, file paths, SQL errors) never leak in responses.
// The correlationId in logs lets you match a client report to the full error.
// ---------------------------------------------------------------------------

export function clientSafeError(error: unknown, fallback = 'Internal server error', ctx?: { path?: string }): string {
  const fp = errorFingerprint(error);
  const fpHash = fingerprintHash(fp);
  const msg = error instanceof Error ? error.message : String(error);
  const cid = correlationId.current;
  spikeDetector.record({ fingerprint: fp, message: msg });
  logger.error(msg, {
    error,
    fingerprint: fp,
    fingerprintHash: fpHash,
    path: ctx?.path,
    correlationId: cid,
  });
  // Client gets: generic message + error CLASS (safe) + fingerprint hash +
  // correlation id. Enough verbosity to report/debug ("grep the log for
  // ref:xxxx"), without leaking upstream error details, paths, or SQL.
  const kind = error instanceof Error ? error.constructor.name : 'Error';
  const ref = cid ? `${fpHash}/${cid}` : fpHash;
  return `${fallback} (${kind}, ref: ${ref})`;
}
