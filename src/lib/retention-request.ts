export const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650;

export function parseRetentionDays(value: string | null): number | { error: string } {
  if (value === null || value === '') return DEFAULT_RETENTION_DAYS;
  if (!/^\d+$/.test(value)) return { error: 'days must be a whole number' };
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
    return { error: `days must be between 1 and ${MAX_RETENTION_DAYS}` };
  }
  return days;
}
