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
  // Try to extract the full event_ticker from the URL path.
  // Format: https://kalshi.com/markets/{series_ticker}/{event_slug}/{market_ticker}
  //
  // BUG-05: Previously stripped team suffixes from sports event tickers
  // (e.g. KXWCADVANCE-26JUL09FRAMAR → KXWCADVANCE-26JUL09), producing an
  // invalid event_ticker that returns 0 markets. The code then fell back
  // to the series_ticker (KXWCADVANCE), which fetched ALL matches in the
  // series — causing unrelated outcomes like "Argentina advances" to appear
  // in a France vs Morocco market.
  //
  // Fix: The market_ticker in the URL path IS the specific market. We derive
  // the event_ticker by taking the full path segment (which includes team
  // codes). The event_ticker for a specific match is e.g. KXWCADVANCE-26JUL09FRAMAR,
  // NOT KXWCADVANCE-26JUL09. We try the full ticker first, then fall back to
  // progressively shorter prefixes only if the full ticker returns no markets.

  // First, try to extract the full market ticker from the deepest path segment
  const deeper = url.match(/kalshi\.com\/markets\/[^\/]+\/[^\/]+\/([^\/\?#]+)/i);
  if (deeper) {
    const marketTicker = deeper[1].toUpperCase();
    // The event_ticker is the market ticker with the final team/outcome suffix removed
    // e.g. KXWCADVANCE-26JUL09FRAMAR-FRA → event_ticker = KXWCADVANCE-26JUL09FRAMAR
    // e.g. KXWCGAME-26JUL09FRAMAR-TIE → event_ticker = KXWCGAME-26JUL09FRAMAR
    // Pattern: SERIES-YYMMMDD[TEAMCODES]-OUTCOMESUFFIX
    // The event_ticker includes the date + team codes but NOT the outcome suffix
    //
    // For non-sports markets: KXTRUMPSAYMONTH-26JUN01 → event_ticker = KXTRUMPSAYMONTH-26JUN01
    // (no team codes, no outcome suffix)
    //
    // Strategy: Try the full market ticker as event_ticker first (works for markets
    // where the ticker IS the event_ticker). Then try stripping the last segment
    // after the final hyphen (outcome suffix). The scan route already has fallback
    // to series_ticker, so we just need to return the most specific valid ticker.

    // Remove the outcome suffix: everything after the last hyphen
    // But only if what remains still contains a date pattern (to avoid stripping
    // the date from a simple SERIES-DATE ticker)
    const lastHyphen = marketTicker.lastIndexOf('-');
    if (lastHyphen > 0) {
      const withoutSuffix = marketTicker.slice(0, lastHyphen);
      // Check if withoutSuffix still has a date pattern (YYMMMDD)
      if (/-\d{2}[A-Z]{3}\d{2}/.test(withoutSuffix)) {
        return withoutSuffix;
      }
    }
    // Fall back: return the full market ticker (works when ticker == event_ticker)
    return marketTicker;
  }

  // Fallback: just return the series_ticker (first path segment)
  const match = url.match(/kalshi\.com\/markets\/([^\/]+)/);
  if (!match) return null;
  return match[1].toUpperCase();
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
 * BUG-05c: Previously this filtered too aggressively — different market types
 * (Moneyline, totals, props) for the SAME match often have different ticker
 * patterns that don't contain the exact match key. Now we use a two-pass
 * approach: first try exact match-key filtering, and if that yields fewer
 * than 4 markets (typically just the two "advances" sides), fall back to
 * filtering by the date portion only (which is shared across all market types
 * for the same match). This surfaces ALL market types per event.
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

  // Pass 1: exact match-key filtering (original behavior)
  const exactFiltered = kMarkets.filter(km => {
    const ticker = km.ticker.toUpperCase();
    return ticker.includes(key);
  });

  // If exact filtering gives us a good set (4+ markets = likely includes
  // multiple market types), return it.
  if (exactFiltered.length >= 4) return exactFiltered;

  // Pass 2 (BUG-05c): Extract the date portion from the match key and filter
  // by that. The date (e.g. "26JUL02") is shared across ALL market types for
  // the same match — advances, Moneyline, totals, props, etc.
  // Match key formats: "26JUL02POR", "26JUL09FRAMAR", "FRAMOR" (multi-game)
  const dateMatch = key.match(/^(\d{2}[A-Z]{3}\d{2})/);
  if (dateMatch) {
    const dateKey = dateMatch[1];
    const dateFiltered = kMarkets.filter(km => {
      const ticker = km.ticker.toUpperCase();
      return ticker.includes(dateKey);
    });
    if (dateFiltered.length > exactFiltered.length) {
      return dateFiltered;
    }
  }

  // For multi-game match keys (no date, e.g. "FRAMOR"), try filtering by
  // the full key as substring — this catches multi-game extended format
  // markets that share the match key in their ticker.
  if (exactFiltered.length > 0) return exactFiltered;

  // Fall back to unfiltered to avoid breaking the scan entirely.
  return kMarkets;
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
