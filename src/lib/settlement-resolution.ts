export type ResolutionOutcome = 'yes' | 'no';
export type ResolutionSource = 'kalshi_market_settlement' | 'polymarket_clob_market';

export interface VerifiedResolution {
  verified: true;
  source: ResolutionSource;
  outcome: ResolutionOutcome;
  yesPayoutCents: 0 | 100;
  noPayoutCents: 0 | 100;
  validationStatus: 'verified';
}

export interface UnverifiedResolution {
  verified: false;
  source: ResolutionSource;
  outcome: null;
  yesPayoutCents: null;
  noPayoutCents: null;
  validationStatus: 'unverified';
  validationError: string;
}

export type SettlementResolution = VerifiedResolution | UnverifiedResolution;

function unverified(source: ResolutionSource, validationError: string): UnverifiedResolution {
  return { verified: false, source, outcome: null, yesPayoutCents: null, noPayoutCents: null, validationStatus: 'unverified', validationError };
}

export function normalizeKalshiResolution(market: {
  status?: unknown;
  settlement_value_dollars?: unknown;
}): SettlementResolution {
  const source = 'kalshi_market_settlement' as const;
  if (typeof market.status !== 'string' || !['settled', 'finalized', 'resolved'].includes(market.status.toLowerCase())) {
    return unverified(source, 'Kalshi market is not in a terminal state');
  }
  if (typeof market.settlement_value_dollars !== 'string') {
    return unverified(source, 'Kalshi settlement payout is missing or malformed');
  }
  const value = market.settlement_value_dollars.trim();
  if (/^1(?:\.0+)?$/.test(value)) return { verified: true, source, outcome: 'yes', yesPayoutCents: 100, noPayoutCents: 0, validationStatus: 'verified' };
  if (/^0(?:\.0+)?$/.test(value)) return { verified: true, source, outcome: 'no', yesPayoutCents: 0, noPayoutCents: 100, validationStatus: 'verified' };
  return unverified(source, 'Kalshi settlement payout must be exactly 0 or 1');
}

export function normalizePolymarketResolution(market: {
  closed?: unknown;
  tokens?: unknown;
}): SettlementResolution {
  const source = 'polymarket_clob_market' as const;
  if (market.closed !== true) return unverified(source, 'Polymarket market is not explicitly closed');
  if (!Array.isArray(market.tokens)) return unverified(source, 'Polymarket outcome tokens are missing');
  const yesTokens = market.tokens.filter((token): token is { outcome: string; winner: boolean } =>
    typeof token === 'object' && token !== null && typeof (token as { outcome?: unknown }).outcome === 'string' && (token as { outcome: string }).outcome.toLowerCase() === 'yes');
  const noTokens = market.tokens.filter((token): token is { outcome: string; winner: boolean } =>
    typeof token === 'object' && token !== null && typeof (token as { outcome?: unknown }).outcome === 'string' && (token as { outcome: string }).outcome.toLowerCase() === 'no');
  if (yesTokens.length !== 1 || noTokens.length !== 1) return unverified(source, 'Polymarket must contain exactly one YES and one NO token');
  if (typeof yesTokens[0].winner !== 'boolean' || typeof noTokens[0].winner !== 'boolean') return unverified(source, 'Polymarket winner flags must both be explicit booleans');
  if (yesTokens[0].winner === noTokens[0].winner) return unverified(source, 'Polymarket winner flags conflict');
  return yesTokens[0].winner
    ? { verified: true, source, outcome: 'yes', yesPayoutCents: 100, noPayoutCents: 0, validationStatus: 'verified' }
    : { verified: true, source, outcome: 'no', yesPayoutCents: 0, noPayoutCents: 100, validationStatus: 'verified' };
}
