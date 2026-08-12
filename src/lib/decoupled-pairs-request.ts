export type DecoupledPairCreateRequest = {
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle: string;
  pmTitle: string;
};

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_TITLE_LENGTH = 500;

function parseBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

export function parseDecoupledPairCreateRequest(
  body: Record<string, unknown>,
): DecoupledPairCreateRequest | { error: string } {
  const kalshiTicker = parseBoundedText(body.kalshiTicker, MAX_IDENTIFIER_LENGTH);
  const pmConditionId = parseBoundedText(body.pmConditionId, MAX_IDENTIFIER_LENGTH);
  if (!kalshiTicker || !pmConditionId) {
    return { error: 'Missing or invalid kalshiTicker or pmConditionId' };
  }

  const kalshiTitle = body.kalshiTitle === undefined
    ? ''
    : parseBoundedText(body.kalshiTitle, MAX_TITLE_LENGTH);
  const pmTitle = body.pmTitle === undefined
    ? ''
    : parseBoundedText(body.pmTitle, MAX_TITLE_LENGTH);
  if (kalshiTitle === null || pmTitle === null) {
    return { error: 'Invalid or oversized market title' };
  }

  return { kalshiTicker, pmConditionId, kalshiTitle, pmTitle };
}

export function parseDecoupledPairId(value: string | null): string | { error: string } {
  const isUuid = !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const isCouplingKey = !!value && /^v1:kalshi:[^|]{1,200}\|polymarket:.{1,200}$/i.test(value);
  if (!value || (!isUuid && !isCouplingKey)) {
    return { error: 'Missing or invalid id query parameter' };
  }
  return value;
}
