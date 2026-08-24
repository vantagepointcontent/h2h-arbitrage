export type CanonicalMarketExpirySource =
  | 'polymarket_event_end_date'
  | 'polymarket_market_end_date'
  | 'polymarket_event_closed_time'
  | 'kalshi_expected_expiration_time'
  | 'kalshi_latest_expiration_time'
  | 'kalshi_market_close_time';

export interface CanonicalMarketExpiry {
  expiryAt: string;
  source: CanonicalMarketExpirySource;
  sourceId: string;
}

interface KalshiExpiryMarket {
  event_ticker?: string | null;
  ticker?: string | null;
  close_time?: string | null;
  expected_expiration_time?: string | null;
  latest_expiration_time?: string | null;
}

interface PolymarketExpiryMarket {
  endDate?: string | null;
  closedTime?: string | null;
}

function validSourceDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

/**
 * Resolve one event-level expiry from metadata already fetched for the linked
 * venues. Polymarket event metadata remains canonical when populated. Some
 * Gamma events omit endDate even though every linked Kalshi outcome publishes
 * the same close_time; that coherent event close is the authoritative fallback.
 */
export function resolveCanonicalMarketExpiry(input: {
  polymarketEndDate: unknown;
  polymarketEventSlug?: string | null;
  polymarketClosed?: boolean;
  polymarketMarkets?: PolymarketExpiryMarket[];
  kalshiMarkets: KalshiExpiryMarket[];
}): CanonicalMarketExpiry | null {
  if (validSourceDate(input.polymarketEndDate)) {
    const sourceId = input.polymarketEventSlug?.trim();
    if (!sourceId) return null;
    return {
      expiryAt: input.polymarketEndDate,
      source: 'polymarket_event_end_date',
      sourceId,
    };
  }

  const sourceId = input.polymarketEventSlug?.trim();
  const polymarketEndDates = new Set((input.polymarketMarkets ?? [])
    .flatMap((market) => validSourceDate(market.endDate) ? [market.endDate] : []));
  if (sourceId && polymarketEndDates.size === 1) {
    return {
      expiryAt: [...polymarketEndDates][0]!,
      source: 'polymarket_market_end_date',
      sourceId,
    };
  }

  const closedTimes = input.polymarketClosed
    ? (input.polymarketMarkets ?? []).flatMap((market) => validSourceDate(market.closedTime) ? [market.closedTime] : [])
    : [];
  if (sourceId && closedTimes.length > 0) {
    const latestClosedAt = closedTimes.reduce((latest, candidate) => (
      Date.parse(candidate) > Date.parse(latest) ? candidate : latest
    ));
    return {
      expiryAt: new Date(latestClosedAt).toISOString(),
      source: 'polymarket_event_closed_time',
      sourceId,
    };
  }

  const dated = input.kalshiMarkets.filter((market) => validSourceDate(market.close_time));
  const closeTimes = new Set(dated.map((market) => market.close_time));
  const eventTickers = new Set(dated.flatMap((market) => {
    const ticker = market.event_ticker?.trim();
    return ticker ? [ticker] : [];
  }));
  if (closeTimes.size === 1 && eventTickers.size === 1) {
    return {
      expiryAt: [...closeTimes][0]!,
      source: 'kalshi_market_close_time',
      sourceId: [...eventTickers][0]!,
    };
  }

  const scheduled = input.kalshiMarkets.filter((market) => validSourceDate(market.expected_expiration_time));
  const scheduledExpirations = new Set(scheduled.map((market) => market.expected_expiration_time));
  const scheduledEventTickers = new Set(scheduled.flatMap((market) => {
    const ticker = market.event_ticker?.trim();
    return ticker ? [ticker] : [];
  }));
  if (scheduledExpirations.size === 1 && scheduledEventTickers.size === 1) {
    return {
      expiryAt: [...scheduledExpirations][0]!,
      source: 'kalshi_expected_expiration_time',
      sourceId: [...scheduledEventTickers][0]!,
    };
  }
  const latest = input.kalshiMarkets.filter((market) => validSourceDate(market.latest_expiration_time));
  const latestExpirations = new Set(latest.map((market) => market.latest_expiration_time));
  const latestEventTickers = new Set(latest.flatMap((market) => {
    const ticker = market.event_ticker?.trim();
    return ticker ? [ticker] : [];
  }));
  if (latestExpirations.size === 1 && latestEventTickers.size === 1) {
    return {
      expiryAt: [...latestExpirations][0]!,
      source: 'kalshi_latest_expiration_time',
      sourceId: [...latestEventTickers][0]!,
    };
  }
  return null;
}
