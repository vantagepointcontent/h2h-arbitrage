export const DEFAULT_LOG_LIMIT = 250;
export const MAX_LOG_LIMIT = 500;


export function parseLogLimit(value: string | null): number {
  if (value === null || value.trim() === '') return DEFAULT_LOG_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LOG_LIMIT);
}

/** Optional explicit export limit; absent means stream the complete match set. */
export function parseExportLimit(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

/**
 * Optional numeric query filters must never forward NaN or Infinity into the
 * SQLite query layer. Invalid values deliberately behave like an absent
 * filter, preserving the read endpoint's existing forgiving semantics.
 */
export function parseOptionalFiniteNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
