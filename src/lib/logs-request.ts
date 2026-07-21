export const DEFAULT_LOG_LIMIT = 100;
export const MAX_LOG_LIMIT = 500;

export function parseLogLimit(value: string | null): number {
  if (value === null || value.trim() === '') return DEFAULT_LOG_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LOG_LIMIT);
}
