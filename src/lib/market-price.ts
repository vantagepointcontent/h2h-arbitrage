const DECIMAL_PRICE = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

/** Returns a complete, finite decimal value or null for malformed input. */
export function finiteDecimal(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && DECIMAL_PRICE.test(value.trim())
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalizes an exchange quote for a binary contract.
 *
 * Strings must be complete decimal values: permissive parsing (for example,
 * parseFloat("0.42junk")) must never turn malformed upstream data into a
 * tradeable price. Binary-contract prices are bounded from $0 through $1.
 */
export function finiteMarketPrice(value: unknown): number {
  const parsed = finiteDecimal(value);

  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : 0;
}
