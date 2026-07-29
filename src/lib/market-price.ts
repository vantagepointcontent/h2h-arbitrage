const DECIMAL_PRICE = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

/**
 * Normalizes an exchange quote for a binary contract.
 *
 * Strings must be complete decimal values: permissive parsing (for example,
 * parseFloat("0.42junk")) must never turn malformed upstream data into a
 * tradeable price. Binary-contract prices are bounded from $0 through $1.
 */
export function finiteMarketPrice(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && DECIMAL_PRICE.test(value.trim())
        ? Number(value)
        : NaN;

  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}
