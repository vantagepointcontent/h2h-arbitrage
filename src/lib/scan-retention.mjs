export const MINIMUM_ZERO_ARB_RETENTION_DAYS = 7;

export const scanRetentionDeleteSql =
  'DELETE FROM scan_results WHERE scanned_at < ? AND COALESCE(positive_arb_count, 0) = 0';

export function boundedZeroArbRetentionDays(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MINIMUM_ZERO_ARB_RETENTION_DAYS;
  return Math.max(MINIMUM_ZERO_ARB_RETENTION_DAYS, Math.floor(parsed));
}
