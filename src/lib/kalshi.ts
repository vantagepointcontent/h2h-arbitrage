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

// ── BUG-05 Sub-Issue 3: Multi-series fetch for same match ──────────────
//
// Kalshi organises markets for the same match into separate series:
//   KXWCGAME-26JUL09FRAMAR  → Moneyline (Regulation Time)
//   KXWCADVANCE-26JUL09FRAMAR → Advance (who progresses)
//   KXWCTOTAL-26JUL09FRAMAR → Total goals
//   KXWCSPREAD-26JUL09FRAMAR → Spread
//   KXWCSCORE-26JUL09FRAMAR → Correct score
//   KXWCBTTS-26JUL09FRAMAR → Both teams to score
//
// When the user pastes an "advances" URL, we only fetch KXWCADVANCE markets
// and miss Moneyline, totals, etc. We construct sibling event tickers by
// swapping the bet-type suffix on the series ticker and fetching each in
// parallel. This avoids the 14MB+ series API call.

/** Known bet-type suffixes that Kalshi uses for match-specific series.
 *  The original series is always included automatically. */
const BET_TYPE_SUFFIXES = ['GAME', 'ADVANCE', 'TOTAL', 'SPREAD', 'SCORE', 'BTTS', 'MATCHUP'];

/** Given a series ticker (e.g. KXWCADVANCE), return candidate sibling series
 *  tickers (KXWCGAME, KXWCTOTAL, etc.) by swapping the bet-type suffix.
 *  No API call needed — constructed locally. */
function getSiblingSeriesTickers(seriesTicker: string): string[] {
  const prefixMatch = seriesTicker.match(/^(KX[A-Z]+?)(GAME|ADVANCE|TOTAL|SPREAD|SCORE|BTTS|MATCHUP|STAGEOFELIM|WINNER|CHAMPION)$/i);
  if (!prefixMatch) return [];
  const prefix = prefixMatch[1].toUpperCase();
  return BET_TYPE_SUFFIXES
    .map(suffix => `${prefix}${suffix}`)
    .filter(t => t !== seriesTicker.toUpperCase());
}

/** Extract the series ticker from a Kalshi URL (first path segment after /markets/). */
export function extractKalshiSeriesFromUrl(url: string): string | null {
  const match = url.match(/kalshi\.com\/markets\/([^\/]+)/i);
  return match ? match[1].toUpperCase() : null;
}

/** BUG-07/BUG-05c: Fetch markets from ALL related Kalshi series for a match.
 *  Given the original event ticker (e.g. KXWCADVANCE-26JUL09FRAMARFRA-FRA) and the
 *  series ticker (KXWCADVANCE), discovers sibling series (KXWCGAME, KXWCTOTAL,
 *  etc.) and fetches their event markets for the same match.
 *
 *  Key insight: different series use different event ticker formats for the same
 *  match. The "advances" series uses team suffixes (KXWCADVANCE-26JUL09FRAMARFRA-FRA),
 *  but "game"/Moneyline uses a single event without team suffix
 *  (KXWCGAME-26JUL09FRAMARFRA). So we try multiple suffix variants per sibling:
 *    1. Full suffix (with team): KXWCGAME-26JUL09FRAMARFRA-FRA
 *    2. Match-only suffix (strip last -TEAM): KXWCGAME-26JUL09FRAMARFRA
 *    3. Date-only suffix: KXWCGAME-26JUL09
 *  The first variant that returns markets wins.
 *
 *  Returns the combined array of markets from all series. */
export async function fetchKalshiMultiSeriesMarkets(
  eventTicker: string,
  seriesTicker: string,
): Promise<{ markets: KalshiMarket[]; seriesFetched: string[] }> {
  // Always fetch the original event ticker first
  const originalMarkets = await fetchKalshiEventMarkets(eventTicker).catch(() => []);
  const seriesFetched = [eventTicker];

  // Extract the match suffix from the event ticker
  // KXWCADVANCE-26JUL09FRAMARFRA-FRA → suffix = 26JUL09FRAMARFRA-FRA
  const suffixMatch = eventTicker.match(/^[A-Z]+-(.+)$/);
  if (!suffixMatch) {
    return { markets: originalMarkets, seriesFetched };
  }
  const fullSuffix = suffixMatch[1]; // e.g. 26JUL09FRAMARFRA-FRA

  // Build candidate suffixes to try for sibling series.
  // Different Kalshi bet types use different event ticker formats:
  //   ADVANCE: KXWCADVANCE-26JUL09FRAMARFRA-FRA (with team)
  //   GAME:    KXWCGAME-26JUL09FRAMARFRA (no team — single moneyline market)
  //   TOTAL:   KXWCTOTAL-26JUL09FRAMARFRA (no team)
  //   SPREAD:  KXWCSPREAD-26JUL09FRAMARFRA-FRA (with team)
  const suffixVariants: string[] = [fullSuffix];

  // Strip the last -TEAM segment (e.g. -FRA, -MOR, -POR)
  const teamStripped = fullSuffix.replace(/-[A-Z]{2,4}$/, '');
  if (teamStripped !== fullSuffix) {
    suffixVariants.push(teamStripped); // 26JUL09FRAMARFRA
  }

  // Strip to date-only (e.g. 26JUL09) — some series use date-only event tickers
  const dateOnly = fullSuffix.match(/^(\d{2}[A-Z]{3}\d{2})/);
  if (dateOnly) {
    suffixVariants.push(dateOnly[1]); // 26JUL09
  }

  // Get sibling series tickers (constructed locally — no API call)
  const siblings = getSiblingSeriesTickers(seriesTicker);
  // Filter out the original series (already fetched)
  const otherSeries = siblings.filter(s => s !== seriesTicker);

  if (otherSeries.length === 0) {
    return { markets: originalMarkets, seriesFetched };
  }

  // For each sibling series, try each suffix variant until one returns markets.
  // All siblings are fetched in parallel; within each, variants are tried sequentially.
  const results = await Promise.all(
    otherSeries.map(async (series) => {
      for (const suffix of suffixVariants) {
        const ticker = `${series}-${suffix}`;
        try {
          const markets = await fetchKalshiEventMarkets(ticker);
          if (markets.length > 0) {
            seriesFetched.push(ticker);
            return markets;
          }
        } catch {
          // Try next variant
        }
      }
      return [] as KalshiMarket[];
    }),
  );

  // Combine all markets, dedup by ticker
  const allMarkets = [...originalMarkets, ...results.flat()];
  const seen = new Set<string>();
  const deduped = allMarkets.filter(m => {
    if (seen.has(m.ticker)) return false;
    seen.add(m.ticker);
    return true;
  });

  return { markets: deduped, seriesFetched };
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
