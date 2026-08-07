export const DEFAULT_LOG_LIMIT = 100;
export const MAX_LOG_LIMIT = 500;
/** UI-035: export can stream up to 50,000 rows while the interactive JSON endpoint stays capped at 500. */
export const MAX_EXPORT_LOG_LIMIT = 50000;

export function parseLogLimit(value: string | null): number {
  if (value === null || value.trim() === '') return DEFAULT_LOG_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LOG_LIMIT);
}

/** UI-035: export row limit parser. Cap is MAX_EXPORT_LOG_LIMIT. */
export function parseExportLimit(value: string | null): number {
  if (value === null || value.trim() === '') return MAX_EXPORT_LOG_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MAX_EXPORT_LOG_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_EXPORT_LOG_LIMIT);
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
