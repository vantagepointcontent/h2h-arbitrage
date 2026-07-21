export type DecoupledPairCreateRequest = {
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle: string;
  pmTitle: string;
};

export function parseDecoupledPairCreateRequest(
  body: Record<string, unknown>,
): DecoupledPairCreateRequest | { error: string } {
  const kalshiTicker = typeof body.kalshiTicker === 'string' ? body.kalshiTicker.trim() : '';
  const pmConditionId = typeof body.pmConditionId === 'string' ? body.pmConditionId.trim() : '';
  if (!kalshiTicker || !pmConditionId) {
    return { error: 'Missing or invalid kalshiTicker or pmConditionId' };
  }

  return {
    kalshiTicker,
    pmConditionId,
    kalshiTitle: typeof body.kalshiTitle === 'string' ? body.kalshiTitle.trim() : '',
    pmTitle: typeof body.pmTitle === 'string' ? body.pmTitle.trim() : '',
  };
}

export function parseDecoupledPairId(value: string | null): string | { error: string } {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return { error: 'Missing or invalid id query parameter' };
  }
  return value;
}
