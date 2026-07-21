const MAX_PAIR_ID_LENGTH = 128;

export function parseReviewPairId(value: unknown): { pairId: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'Missing or invalid pairId' };
  const pairId = value.trim();
  if (!pairId || pairId.length > MAX_PAIR_ID_LENGTH) return { error: 'Missing or invalid pairId' };
  return { pairId };
}
