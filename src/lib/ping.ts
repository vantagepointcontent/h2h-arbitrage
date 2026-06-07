// Platform Availability Ping — lightweight availability checks with in-memory caching.
// Searches a platform's API to see if a given market/event exists there.

import { fetchKalshiEventMarkets, fetchKalshiSeriesMarkets, KalshiMarket } from './kalshi';
import { fetchPolymarketEvent, PMEvent, PMMarket } from './polymarket';
import { getPredictionHuntMarkets } from './predictionhunt';
import logger from './logger';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const API_TIMEOUT_MS = 2000; // 2s hard cap for ping — must be fast

interface CacheEntry {
  data: PingResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt < now) cache.delete(key);
    }
  }, 60_000); // every minute
}
startCleanup();

function cacheKey(platform: string, query: string): string {
  return `ping:${platform}:${normalizeQuery(query)}`;
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Types ────────────────────────────────────────────────────────────────

export interface MatchedMarket {
  title: string;
  url: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  lastPrice: number | null;
}

export interface PingResult {
  available: boolean;
  platform: string;
  matches: MatchedMarket[];
  responseTimeMs: number;
  cachedUntil: number; // timestamp
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Check if a market/event is available on a given platform.
 *
 * @param query - Market title, event slug, or platform URL
 * @param platform - Target platform: 'kalshi' | 'polymarket' | 'predictionhunt'
 * @returns availability result with match details
 */
export async function pingPlatform(query: string, platform: string): Promise<PingResult> {
  const normQuery = normalizeQuery(query);
  const key = cacheKey(platform, normQuery);

  // Check cache
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const start = Date.now();
  let result: PingResult;

  try {
    switch (platform.toLowerCase()) {
      case 'kalshi':
        result = await searchKalshi(query);
        break;
      case 'polymarket':
        result = await searchPolymarket(query);
        break;
      case 'predictionhunt':
        result = await searchPredictionHunt(query);
        break;
      default:
        result = {
          available: false,
          platform,
          matches: [],
          responseTimeMs: 0,
          cachedUntil: Date.now() + CACHE_TTL_MS,
        };
    }
  } catch (err: any) {
    logger.warn(`[ping] ${platform} search failed:`, err.message);
    result = {
      available: false,
      platform,
      matches: [],
      responseTimeMs: Date.now() - start,
      cachedUntil: Date.now() + CACHE_TTL_MS,
    };
  }

  result.responseTimeMs = Date.now() - start;
  result.cachedUntil = Date.now() + CACHE_TTL_MS;

  // Store in cache
  cache.set(key, { data: result, expiresAt: result.cachedUntil });

  return result;
}

/** Clear all cached ping results. */
export function clearPingCache(): void {
  cache.clear();
}

/** Get cache stats for debugging. */
export function pingCacheStats(): { size: number } {
  return { size: cache.size };
}

// ── Kalshi Search ────────────────────────────────────────────────────────

function extractKalshiEventTicker(url: string): string | null {
  const match = url.match(/kalshi\.com\/markets\/([^\/]+)/);
  if (!match) return null;

  const firstSegment = match[1].toUpperCase();

  // Try deeper path for full event_ticker with date suffix
  const deeper = url.match(/kalshi\.com\/markets\/[^\/]+\/[^\/]+\/([A-Za-z0-9_-]+)/);
  if (deeper) {
    const deepTicker = deeper[1].toUpperCase();
    if (deepTicker.length > firstSegment.length) return deepTicker;
  }

  return firstSegment;
}

async function searchKalshi(query: string): Promise<PingResult> {
  let markets: KalshiMarket[] = [];

  // If query looks like a Kalshi URL, extract event_ticker and fetch directly
  const eventTicker = extractKalshiEventTicker(query);
  if (eventTicker) {
    try {
      markets = await withTimeout(
        fetchKalshiEventMarkets(eventTicker),
        API_TIMEOUT_MS,
      );
    } catch {
      // Try series fallback
      const seriesMatch = eventTicker.match(/^([A-Z]+)/);
      const seriesPrefix = seriesMatch ? seriesMatch[1] : null;
      if (seriesPrefix && seriesPrefix !== eventTicker) {
        try {
          markets = await withTimeout(
            fetchKalshiSeriesMarkets(seriesPrefix),
            API_TIMEOUT_MS,
          );
        } catch {/* ignore */}
      }
    }
  } else {
    // Free-text query: try to find matching markets
    // Strategy: search by potential series prefixes
    const words = query.toLowerCase().split(/\s+/);
    // Try common series prefixes from the query
    const possiblePrefixes = words
      .filter(w => w.length >= 3)
      .map(w => w.toUpperCase());

    // Try each word as a series ticker
    for (const prefix of possiblePrefixes) {
      try {
        const found = await withTimeout(
          fetchKalshiSeriesMarkets(prefix),
          API_TIMEOUT_MS / possiblePrefixes.length,
        );
        // Filter to markets whose titles match the query
        const normQ = normalizeQuery(query);
        const matched = found.filter(m =>
          (m.title || '').toLowerCase().includes(normQ)
        );
        if (matched.length > 0) {
          markets = matched;
          break;
        }
      } catch { /* try next prefix */ }
    }
  }

  const matches: MatchedMarket[] = markets.map(m => ({
    title: m.title || m.ticker,
    url: `https://kalshi.com/markets/${m.ticker}`,
    yesBid: m.yes_bid_dollars ? parseFloat(m.yes_bid_dollars) : null,
    yesAsk: m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : null,
    lastPrice: m.last_price_dollars ? parseFloat(m.last_price_dollars) : null,
  }));

  return {
    available: matches.length > 0,
    platform: 'kalshi',
    matches,
    responseTimeMs: 0,
    cachedUntil: Date.now() + CACHE_TTL_MS,
  };
}

// ── Polymarket Search ───────────────────────────────────────────────────

function extractPolymarketSlug(url: string): string | null {
  const match = url.match(/polymarket\.com\/(?:event|sports(?:\/[^/]+)*)\/([^/\s?#]+)/);
  return match ? match[1] : null;
}

async function searchPolymarket(query: string): Promise<PingResult> {
  // If query is a Polymarket URL, fetch the event directly
  const slug = extractPolymarketSlug(query);
  if (slug) {
    try {
      const event = await withTimeout(
        fetchPolymarketEvent(slug),
        API_TIMEOUT_MS,
      );
      if (event && event.markets && event.markets.length > 0) {
        const matches: MatchedMarket[] = event.markets.map((m: PMMarket) => ({
          title: m.question || m.slug,
          url: `https://polymarket.com/event/${slug}`,
          yesBid: m.bestBid || null,
          yesAsk: m.bestAsk || null,
          lastPrice: m.lastTradePrice || null,
        }));
        return {
          available: true,
          platform: 'polymarket',
          matches,
          responseTimeMs: 0,
          cachedUntil: Date.now() + CACHE_TTL_MS,
        };
      }
    } catch { /* fall through to search */ }
  }

  // Free-text search via Gamma search endpoint
  try {
    const searchUrl = `https://gamma-api.polymarket.com/events/search?q=${encodeURIComponent(query)}&limit=5&_t=${Date.now()}`;
    const res = await withTimeout(
      fetch(searchUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
        cache: 'no-store',
      }),
      API_TIMEOUT_MS,
    );

    if (!res.ok) {
      return {
        available: false,
        platform: 'polymarket',
        matches: [],
        responseTimeMs: 0,
        cachedUntil: Date.now() + CACHE_TTL_MS,
      };
    }

    const data = await res.json();
    const events = Array.isArray(data) ? data : (data.events || []);
    const matches: MatchedMarket[] = [];

    for (const event of events.slice(0, 5)) {
      if (event.markets) {
        for (const m of (event.markets as PMMarket[]).slice(0, 3)) {
          matches.push({
            title: m.question || m.slug,
            url: `https://polymarket.com/event/${event.slug}`,
            yesBid: m.bestBid || null,
            yesAsk: m.bestAsk || null,
            lastPrice: m.lastTradePrice || null,
          });
        }
      }
    }

    return {
      available: matches.length > 0,
      platform: 'polymarket',
      matches,
      responseTimeMs: 0,
      cachedUntil: Date.now() + CACHE_TTL_MS,
    };
  } catch {
    // If Gamma search endpoint doesn't exist, return empty
    return {
      available: false,
      platform: 'polymarket',
      matches: [],
      responseTimeMs: 0,
      cachedUntil: Date.now() + CACHE_TTL_MS,
    };
  }
}

// ── PredictionHunt Search ────────────────────────────────────────────────

async function searchPredictionHunt(query: string): Promise<PingResult> {
  const normQ = normalizeQuery(query);
  const markets = await getPredictionHuntMarkets();

  const matches: MatchedMarket[] = [];
  for (const m of markets) {
    const titleNorm = (m.title || '').toLowerCase();
    if (titleNorm.includes(normQ) || normQ.split(' ').some(w => titleNorm.includes(w))) {
      matches.push({
        title: m.title,
        url: m.polymarketUrl || m.kalshiUrl || null,
        yesBid: m.pmPrice?.yesBid ?? m.kalshiPrice?.yesBid ?? null,
        yesAsk: m.pmPrice?.yesAsk ?? m.kalshiPrice?.yesAsk ?? null,
        lastPrice: null,
      });
      if (matches.length >= 5) break;
    }
  }

  return {
    available: matches.length > 0,
    platform: 'predictionhunt',
    matches,
    responseTimeMs: 0,
    cachedUntil: Date.now() + CACHE_TTL_MS,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
  );
  return Promise.race([promise, timeout]);
}
