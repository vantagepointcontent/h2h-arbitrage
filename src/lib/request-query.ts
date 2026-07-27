export function parseBoundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** Normalizes optional text filters and rejects oversized query values. */
export function parseOptionalBoundedText(value: string | null, maxLength = 200): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}
