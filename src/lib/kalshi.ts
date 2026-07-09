// Kalshi API Client — no auth needed for market data
// Base URL: https://external-api.kalshi.com/trade-api/v2

import { rateLimiters } from '@/lib/rate-limiter';
import { createTtlMemo } from '@/lib/ttl-cache';

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
  yes_sub_title?: string;
  no_sub_title?: string;
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
  // For sports: /markets/kxwcadvance/world-cup-advance/kxwcadvance-26jul02por -> strip team suffix -> KXWCADVANCE-26JUL02
  const deeper = url.match(/kalshi\.com\/markets\/[^\/]+\/[^\/]+\/([A-Z0-9-]+)/i);
  if (deeper) {
    const deepTicker = deeper[1].toUpperCase();
    // Strip team/outcome suffix from sports market tickers
    // Pattern: SERIES-YYMMMDDXXX -> SERIES-YYMMMDD (XXX = team code like POR, CRO, ENG)
    // e.g. KXWCADVANCE-26JUL02POR -> KXWCADVANCE-26JUL02
    const eventLevel = deepTicker.replace(/^([A-Z]+-\d{2}[A-Z]{3}\d{2})[A-Z]{2,}$/, '$1');
    if (eventLevel !== deepTicker && eventLevel.length > firstSegment.length) {
      return eventLevel;
    }
    // Multi-game extended format: SERIES-SYYYYT#-MATCHKEY
    // e.g. KXMVESPORTSMULTIGAMEEXTENDED-S2026T1-FRAMOR -> KXMVESPORTSMULTIGAMEEXTENDED-S2026T1
    // The SYYYYT# part is the season/tournament identifier, FRAMOR is the match key
    const multiGameEventLevel = deepTicker.replace(/^([A-Z]+-S\d+T\d+)-[A-Z]+$/, '$1');
    if (multiGameEventLevel !== deepTicker && multiGameEventLevel.length > firstSegment.length) {
      return multiGameEventLevel;
    }
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

/**
 * Extract a match-key from a Kalshi URL to identify the specific match within a
 * multi-game or multi-match event. Returns null when the URL's event ticker
 * already uniquely identifies one match (no filtering needed).
 *
 * Three ticker formats are handled:
 *
 * 1. Multi-game extended:
 *    Ticker: KXMVESPORTSMULTIGAMEEXTENDED-S2026T1-FRAMOR
 *    Match key: FRAMOR (last segment after the SYYYYT# season identifier)
 *
 * 2. Compound sports (two-team match):
 *    Ticker: KXWCADVANCE-26JUL09FRAMAR-FRA
 *    Match key: 26JUL09FRAMAR (date + match-teams portion, shared by both sides)
 *    Both -FRA and -MAR markets share this key, while ARGNED-ARG/-NED don't.
 *
 * 3. Simple sports (single team suffix):
 *    Ticker: KXWCADVANCE-26JUL02POR
 *    Match key: 26JUL02POR (date + team code, unique per match)
 */
export function extractKalshiMatchKey(url: string): string | null {
  const deeper = url.match(/kalshi\.com\/markets\/[^\/]+\/[^\/]+\/([A-Z0-9-]+)/i);
  if (!deeper) return null;
  const marketTicker = deeper[1].toUpperCase();

  // Multi-game extended: SERIES-SYYYYT#-MATCHKEY  →  match key = MATCHKEY
  const multiMatch = marketTicker.match(/^[A-Z]+-S\d+T\d+-([A-Z]+)$/);
  if (multiMatch) return multiMatch[1];

  // Compound sports: SERIES-YYMMMDD<matchkey>-<teamcode>
  // e.g. KXWCADVANCE-26JUL09FRAMAR-FRA → match key = 26JUL09FRAMAR
  // The date+match portion (without the trailing -TEAM) is shared by both teams.
  const compoundMatch = marketTicker.match(/^[A-Z]+-(\d{2}[A-Z]{3}\d{2}[A-Z]+)-[A-Z]+$/);
  if (compoundMatch) return compoundMatch[1];

  // Simple sports: SERIES-YYMMMDD<teamcode>  →  match key = YYMMMDD<teamcode>
  // e.g. KXWCADVANCE-26JUL02POR → match key = 26JUL02POR
  const sportsMatch = marketTicker.match(/^[A-Z]+-(\d{2}[A-Z]{3}\d{2}[A-Z]{2,})$/);
  if (sportsMatch) return sportsMatch[1];

  return null;
}

/**
 * Filter Kalshi markets to only those belonging to a specific match within a
 * multi-game or multi-match event. When a matchKey is available (extracted from
 * the URL's market ticker), only markets whose ticker contains the match key
 * are kept. This prevents surfacing outcomes from other matches in the same
 * event (e.g. "Argentina advances" when looking at France vs Morocco).
 *
 * Returns the original array unchanged if no matchKey is provided or if
 * filtering eliminates everything (falls back to unfiltered as safety net).
 */
export function filterKalshiMarketsToMatch(
  kMarkets: KalshiMarket[],
  matchKey: string | null,
): KalshiMarket[] {
  if (!matchKey) return kMarkets;
  const key = matchKey.toUpperCase();
  const filtered = kMarkets.filter(km => {
    const ticker = km.ticker.toUpperCase();
    // The match key is a substring that uniquely identifies the match within
    // the event. For multi-game: ticker ends with -MATCHKEY. For compound
    // sports: ticker contains DATE+MATCHKEY. For simple sports: ticker ends
    // with DATE+TEAMCODE. All three are covered by includes().
    return ticker.includes(key);
  });
  // If filtering eliminates everything (shouldn't happen with correct data),
  // fall back to unfiltered to avoid breaking the scan entirely.
  return filtered.length > 0 ? filtered : kMarkets;
}

export function extractKalshiMarketTicker(url: string): string | null {
  // Extract the last path segment (specific market ticker)
  const match = url.match(/kalshi\.com\/markets\/[^\/]+\/[^\/]+\/([^\/\?]+)/);
  return match ? match[1].toUpperCase() : null;
}

export function extractKalshiTicker(url: string): string | null {
  // Prefer explicit operational market ticker from query param if present
  // e.g. ?op_market_ticker=KXWCGAME-26JUN17ENGCRO-ENG
  const op = new URL(url, 'https://kalshi.com').searchParams.get('op_market_ticker');
  if (op) return op.toUpperCase();

  const match = url.match(/kalshi\.com\/markets\/[^\/]+\/[^\/]+\/([^\/\?]+)/);
  return match ? match[1].toUpperCase() : null;
}

const kalshiMemo = createTtlMemo<KalshiMarket[]>(10_000);
const kalshiSingleMemo = createTtlMemo<KalshiMarket | null>(10_000);

export async function fetchKalshiEventMarkets(eventTicker: string): Promise<KalshiMarket[]> {
  return kalshiMemo(`event:${eventTicker}`, async () => {
  const res = await rateLimiters.kalshi.execute(() =>
    fetch(
      `https://external-api.kalshi.com/trade-api/v2/markets?event_ticker=${eventTicker}&status=open&depthP=Infinity&_t=${Date.now()}`,
      { headers: { 'Accept': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5000) },
    ),
  );
  if (!res.ok) throw new Error(`Kalshi API error: ${res.status}`);
  const data = await res.json();
  return data.markets || [];
  });
}

export async function fetchKalshiSeriesMarkets(seriesTicker: string): Promise<KalshiMarket[]> {
  return kalshiMemo(`series:${seriesTicker}`, async () => {
  const res = await rateLimiters.kalshi.execute(() =>
    fetch(
      `https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=${seriesTicker}&status=open&depthP=Infinity&_t=${Date.now()}`,
      { headers: { 'Accept': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5000) },
    ),
  );
  if (!res.ok) throw new Error(`Kalshi API error: ${res.status}`);
  const data = await res.json();
  return data.markets || [];
  });
}

export async function fetchKalshiMarket(ticker: string): Promise<KalshiMarket | null> {
  return kalshiSingleMemo(`market:${ticker}`, async () => {
  const res = await rateLimiters.kalshi.execute(() =>
    fetch(
      `https://external-api.kalshi.com/trade-api/v2/markets/${ticker}?depthP=Infinity`,
      { headers: { 'Accept': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5000) },
    ),
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.market || null;
  });
}
