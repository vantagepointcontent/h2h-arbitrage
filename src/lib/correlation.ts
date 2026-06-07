import { v4 as uuidv4 } from 'uuid';
import type { NextApiRequest, NextApiResponse } from 'next';
import { AsyncLocalStorage } from 'node:async_hooks';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

const asyncLocal = new AsyncLocalStorage<string>();

export const correlationId = {
  /**
   * Get the current correlation ID from the async context.
   */
  get current(): string | undefined {
    return asyncLocal.getStore();
  },

  /**
   * Run a callback with a correlation ID bound to the async context.
   */
  run<T>(id: string, fn: () => T): T {
    return asyncLocal.run(id, fn);
  },

  /**
   * Generate a new correlation ID.
   */
  generate(): string {
    return uuidv4();
  },
};

/**
 * Next.js middleware that extracts or generates a correlation ID
 * and binds it to the async local storage for the lifetime of the request.
 */
export function correlationMiddleware(
  req: NextApiRequest,
  _res: NextApiResponse,
  next: () => void,
): void {
  const id = req.headers[CORRELATION_ID_HEADER] as string | undefined;
  const correlationIdValue = id || correlationId.generate();

  // Inject into request object for downstream use
  (req as Record<string, unknown>)[CORRELATION_ID_HEADER] = correlationIdValue;

  correlationId.run(correlationIdValue, next);
}

/**
 * Wrapper for Next.js route handlers that ensures correlation ID propagation.
 * Usage: export async function GET(req) { return withCorrelation(handler)(req); }
 */
export function withCorrelation<T extends (...args: unknown[]) => Response>(
  handler: T,
): T {
  return (async (...args: unknown[]) => {
    const id = correlationId.current ?? correlationId.generate();
    return correlationId.run(id, () => handler(...args));
  }) as T;
}
