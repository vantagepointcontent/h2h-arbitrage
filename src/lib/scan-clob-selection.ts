type PreliminaryOutcome = {
  kalshi?: unknown | null;
  polymarket?: { conditionId?: string | null } | null;
};

/**
 * Full scans only need executable CLOB quotes for cross-platform pairs that
 * preliminary title matching can actually compare. Fetching metadata for every
 * unrelated Polymarket outcome turns large events into 40+ second scans.
 */
export function selectMatchedClobConditionIds(outcomes: PreliminaryOutcome[]): string[] {
  const ids = new Set<string>();
  for (const outcome of outcomes) {
    if (!outcome.kalshi || !outcome.polymarket) continue;
    const id = outcome.polymarket.conditionId?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}
