// Kalshi API Client — no auth needed for market data
// Base URL: https://external-api.kalshi.com/trade-api/v2

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  custom_strike?: Record<string, string>;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  open_interest_fp?: string;
  volume_24h_fp?: string;
  close_time?: string;
  status?: string;
  yes_bid_size_fp?: string;
  no_bid_size_fp?: string;
  yes_ask_size_fp?: string;
  no_ask_size_fp?: string;
}

export function extractKalshiEventTicker(url: string): string | null {
  // Try to extract the full event_ticker pattern first:
  // Format: https://kalshi.com/markets/{series_ticker}/{event_slug}/{market_ticker}
  // The event_ticker is typically series_ticker + date suffix derived from the URL
  // Or: just return the series_ticker and let event_ticker fallback handle it
  const match = url.match(/kalshi\.com\/markets\/([^\/]+)/);
  if (!match) return null;

  const firstSegment = match[1].toUpperCase();

  // Try to extract explicit event_ticker from deeper path if available
  // e.g. /markets/kxtrumpsaymonth/trump-monthly/kxtrumpsaymonth-26jun01 -> event_ticker = KXTRUMPSAYMONTH-26JUN01
  const deeper = url.match(/kalshi\.com\/markets\/[^\/]+\/[^\/]+\/([A-Z0-9-]+)/i);
  if (deeper) {
    const deepTicker = deeper[1].toUpperCase();
    // Only return deeper ticker if it's longer (has date suffix)
    if (deepTicker.length > firstSegment.length) {
      return deepTicker;
    }
  }

  // Also look for any pattern like SERIES-YYYYMMDD in the URL
  const dateMatch = url.match(/kalshi\.com\/markets\/[^\/]+.*[\-_]\/(.*?)(?:\?|#|$)/);
  if (dateMatch && dateMatch[1].includes(firstSegment)) {
    return dateMatch[1].toUpperCase();
  }

  return firstSegment;
}

export function extractKalshiMarketTicker(url: string): string | null {
  // Extract the last path segment (specific market ticker)
  const match = url.match(/kalshi\.com\/markets\/[^\/]+\/[^\/]+\/([^\/\?]+)/);
  return match ? match[1].toUpperCase() : null;
}

export function extractKalshiTicker(url: string): string | null {
  const match = url.match(/kalshi\.com\/markets\/[^\/]+\/[^\/]+\/([^\/\?]+)/);
  return match ? match[1].toUpperCase() : null;
}

export async function fetchKalshiEventMarkets(eventTicker: string): Promise<KalshiMarket[]> {
  const res = await fetch(
    `https://external-api.kalshi.com/trade-api/v2/markets?event_ticker=${eventTicker}&status=open`,
    { headers: { 'Accept': 'application/json' }, cache: 'no-store' }
  );
  if (!res.ok) throw new Error(`Kalshi API error: ${res.status}`);
  const data = await res.json();
  return data.markets || [];
}

export async function fetchKalshiSeriesMarkets(seriesTicker: string): Promise<KalshiMarket[]> {
  const res = await fetch(
    `https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=${seriesTicker}&status=open`,
    { headers: { 'Accept': 'application/json' }, cache: 'no-store' }
  );
  if (!res.ok) throw new Error(`Kalshi API error: ${res.status}`);
  const data = await res.json();
  return data.markets || [];
}

export interface KalshiFetchResult {
  markets: KalshiMarket[];
  source: 'event_ticker' | 'series_ticker' | 'market_ticker' | 'none';
}

export async function fetchKalshiMarket(ticker: string): Promise<KalshiMarket | null> {
  const res = await fetch(
    `https://external-api.kalshi.com/trade-api/v2/markets/${ticker}`,
    { headers: { 'Accept': 'application/json' }, cache: 'no-store' }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.market || null;
}
