const CONDITION_ID = /^0x[a-fA-F0-9]{64}$/;

export function parsePolymarketConditionId(value: string | null): { conditionId: string } | { error: string } {
  const conditionId = value?.trim() ?? '';
  if (!CONDITION_ID.test(conditionId)) return { error: 'Invalid conditionId' };
  return { conditionId };
}
