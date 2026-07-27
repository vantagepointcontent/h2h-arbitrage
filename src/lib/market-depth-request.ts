import { parsePolymarketConditionId } from './polymarket-request';

const KALSHI_TICKER = /^[A-Za-z0-9-]{1,160}$/;

type MarketDepthRequest = {
  kalshiTicker: string;
  pmConditionId: string;
};

/** Validates external identifiers before they are used in upstream orderbook paths. */
export function parseMarketDepthRequest(
  rawKalshiTicker: string | null,
  rawPmConditionId: string | null,
): MarketDepthRequest | { error: string } {
  if (!rawKalshiTicker?.trim() || !rawPmConditionId?.trim()) {
    return { error: 'kalshiTicker and pmConditionId are required' };
  }

  const kalshiTicker = rawKalshiTicker.trim();
  if (!KALSHI_TICKER.test(kalshiTicker)) {
    return { error: 'Invalid kalshiTicker' };
  }

  const parsedConditionId = parsePolymarketConditionId(rawPmConditionId.trim());
  if ('error' in parsedConditionId) {
    return { error: parsedConditionId.error };
  }

  return { kalshiTicker, pmConditionId: parsedConditionId.conditionId };
}
