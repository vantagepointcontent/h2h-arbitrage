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
    return crypto.randomUUID();
  },
};
