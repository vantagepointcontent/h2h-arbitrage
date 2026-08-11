/**
 * Shared scan utilities: withTimeout and chooseBestPmStructure.
 * Used by both scan/route.ts and saved-markets/refresh/refresh-single.ts.
 * Each call site defines its own timeout constants — this module has none.
 */

// matchOutcomes import removed — chooseBestPmStructure no longer needs it

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * Return ALL Polymarket markets — both named (groupItemTitle) and unnamed.
 * matchOutcomes already handles both structures individually, so there is
 * no need to pre-filter. The previous logic discarded half the markets,
 * hiding them from Victor in the manual-matching UI.
 *
 * Signature kept for backward compatibility with the two call sites.
 */
export function chooseBestPmStructure(
  allPmMarkets: any[],
  _kalshiMarkets: any[],
  _pmEventTitle: string,
): any[] {
  return allPmMarkets;
}