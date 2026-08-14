export interface SqliteContentionMetrics {
  busyRetries: number;
  exhaustedWrites: number;
  lastBusyAt: string | null;
}

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

let metrics: SqliteContentionMetrics = {
  busyRetries: 0,
  exhaustedWrites: 0,
  lastBusyAt: null,
};

function sqliteCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  const message = error instanceof Error ? error.message : '';
  return message.match(/SQLITE_BUSY(?:_SNAPSHOT)?/)?.[0] ?? '';
}

function isBusy(error: unknown): boolean {
  return sqliteCode(error).startsWith('SQLITE_BUSY');
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms));
}

export async function withSqliteBusyRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 4));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 25));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isBusy(error)) throw error;
      metrics.lastBusyAt = new Date().toISOString();
      if (attempt >= maxAttempts) {
        metrics.exhaustedWrites += 1;
        throw error;
      }
      metrics.busyRetries += 1;
      const exponential = baseDelayMs * 2 ** (attempt - 1);
      const jitter = baseDelayMs === 0 ? 0 : Math.floor(Math.random() * baseDelayMs);
      await delay(exponential + jitter);
    }
  }
}

export function getSqliteContentionMetrics(reset = false): SqliteContentionMetrics {
  const snapshot = { ...metrics };
  if (reset) metrics = { busyRetries: 0, exhaustedWrites: 0, lastBusyAt: null };
  return snapshot;
}
