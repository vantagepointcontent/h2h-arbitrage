function decimalParts(value: number): { coefficient: bigint; scale: number } | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const match = value.toString().toLowerCase().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  if (!Number.isSafeInteger(exponent)) return null;
  let coefficient = BigInt(`${match[1]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return coefficient > 0n ? { coefficient, scale } : null;
}

/** Exact decimal divisibility check for venue prices and tick sizes. */
export function isPriceAlignedToTick(price: number, tickSize: number): boolean {
  const priceParts = decimalParts(price);
  const tickParts = decimalParts(tickSize);
  if (!priceParts || !tickParts) return false;
  const scale = Math.max(priceParts.scale, tickParts.scale);
  const scaledPrice = priceParts.coefficient * 10n ** BigInt(scale - priceParts.scale);
  const scaledTick = tickParts.coefficient * 10n ** BigInt(scale - tickParts.scale);
  return scaledPrice % scaledTick === 0n;
}
