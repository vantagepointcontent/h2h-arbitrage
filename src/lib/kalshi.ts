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
  // Format: https://kalshi.com/markets/{series_ticker}/.../{market_ticker}
  const match = url.match(/kalshi\.com\/markets\/([^\/]+)/);
  return match ? match[1].toUpperCase() : null;
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
