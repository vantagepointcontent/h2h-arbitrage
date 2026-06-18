import { promises as fs } from 'fs';
import path from 'path';
import { rateLimiters } from '@/lib/rate-limiter';

/* ──────────────────────────── Types ──────────────────────────── */

export interface PredictionHuntMarket {
  id: string;
  eventId: number;
  groupId: number;
  title: string;
  eventType: string;
  confidence: 'high' | 'medium' | 'low';
  eventDate: string | null;
  groupTitle: string;
  polymarketUrl: string | null;
  polymarketId: string | null;
  kalshiUrl: string | null;
  kalshiId: string | null;
  marketCount: number;
  fetchedAt: string;
  // Price data for spread calculation
  pmPrice?: { yesBid: number | null; yesAsk: number | null };
  kalshiPrice?: { yesBid: number | null; yesAsk: number | null };
  spreadPct?: number | null;
}

export interface PhV2Market {
  id: number;
  title: string;
  platform: string;
  source_url: string | null;
  category: string;
  expiration_date: string | null;
  price: { yes_bid: number | null; yes_ask: number | null };
}

/* ──────────────────────────── Config ──────────────────────────── */

const DATA_DIR = path.join(process.cwd(), 'data');
const MARKETS_FILE = path.join(DATA_DIR, 'predictionhunt-markets.json');
const SYNC_LOG_FILE = path.join(DATA_DIR, 'predictionhunt-sync.log.json');

const API_KEY = (process.env.PREDICTIONHUNT_API_KEY || '').trim();
const BASE_URL = 'https://www.predictionhunt.com/api/v2';

const RATE_LIMIT_MS = 600;

export { RATE_LIMIT_MS };

export const CATEGORIES = [
  'sports', 'politics', 'election', 'entertainment', 'economics',
  'crypto', 'science', 'technology', 'weather', 'international',
];

/* ──────────────────────────── Helpers ──────────────────────────── */

async function ensureDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}

function hashMarket(title: string, cat: string): string {
  const base = `${title}|${cat}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) {
    h = ((h << 5) - h + base.charCodeAt(i)) | 0;
  }
  return `ph-${Math.abs(h)}`;
}

export async function fetchPlatformMarkets(platform: string, category?: string, limit = 500): Promise<PhV2Market[]> {
  const url = new URL(`${BASE_URL}/markets`);
  url.searchParams.set('platform', platform);
  url.searchParams.set('status', 'active');
  url.searchParams.set('limit', String(limit));
  if (category) url.searchParams.set('category', category);

  const res = await rateLimiters.predictionhunt.execute(() =>
    fetch(url.toString(), {
      headers: { 'Accept': 'application/json', 'X-API-Key': API_KEY },
    }),
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${platform} ${res.status}: ${text.slice(0,200)}`);
  }

  const data = await res.json();
  if (!data.markets) return [];

  const markets: PhV2Market[] = data.markets.map((m: any) => ({
    id: m.id,
    title: m.title,
    platform: m.platform,
    source_url: m.source_url,
    category: m.category || category || 'unknown',
    expiration_date: m.expiration_date,
    price: m.price || {},
  }));

  return markets;
}

/* Fetch all categories for a platform, paginate via next_cursor */
export async function fetchAllPlatformMarkets(platform: string): Promise<PhV2Market[]> {
  const all: PhV2Market[] = [];
  for (const cat of CATEGORIES) {
    try {
      const ms = await fetchPlatformMarkets(platform, cat);
      all.push(...ms);
    } catch (e: any) {
      console.warn(`[ph] ${platform}/${cat} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }
  return all;
}

/* Match PM + Kalshi markets by title similarity (simplified: exact match after normalization) */
function normalizeTitle(t: string): string {
  return t.toLowerCase()
    .replace(/[.,/#!$%\\^&\\*;:{}=\\-_`~()]/g, '')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Calculate spread percentage between PM and Kalshi prices.
 * spreadPct = |PM_yesAsk - Kalshi_yesBid| / avgPrice * 100
 * Positive spread means arb opportunity (PM ask < Kalshi bid, or vice versa).
 */
function calcSpreadPct(pmPrice: PhV2Market['price'], kalshiPrice: PhV2Market['price']): number | undefined {
  const pmAsk = pmPrice?.yes_ask;
  const kalshiBid = kalshiPrice?.yes_bid;
  if (pmAsk == null || kalshiBid == null || pmAsk <= 0 || kalshiBid <= 0) return undefined;
  const avg = (pmAsk + kalshiBid) / 2;
  if (avg === 0) return undefined;
  return Math.abs(pmAsk - kalshiBid) / avg * 100;
}

export function buildMatches(pmMarkets: PhV2Market[], kMarkets: PhV2Market[]): PredictionHuntMarket[] {
  // Group outcomes by their parent event URL.
  const eventGroups = new Map<string, { pm?: PhV2Market; k?: PhV2Market }>();

  const addToEvent = (m: PhV2Market, platform: 'pm' | 'k') => {
    // Use the parent event URL when possible; fall back to the outcome URL itself.
    const key = deriveEventUrl(m.source_url) || m.source_url || `${m.title}:${platform}`;
    const g = eventGroups.get(key) || { pm: undefined, k: undefined };
    if (platform === 'pm') g.pm = m;
    else g.k = m;
    eventGroups.set(key, g);
  };

  for (const pm of pmMarkets) addToEvent(pm, 'pm');
  for (const k of kMarkets) addToEvent(k, 'k');

  const results: PredictionHuntMarket[] = [];
  const seen = new Set<string>();

  for (const [eventUrl, group] of eventGroups) {
    const { pm, k } = group;
    if (!pm || !k) continue;

    const title = deriveEventTitle(pm.title, k.title) || pm.title;
    const key = `${pm.id}-${k.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const spreadPct = calcSpreadPct(pm.price, k.price);

    results.push({
      id: hashMarket(title, pm.category),
      eventId: pm.id,
      groupId: k.id,
      title,
      eventType: pm.category,
      confidence: 'medium',
      eventDate: pm.expiration_date || k.expiration_date || null,
      groupTitle: title,
      polymarketUrl: eventUrl,
      polymarketId: String(pm.id),
      kalshiUrl: eventUrl,
      kalshiId: String(k.id),
      marketCount: 2,
      fetchedAt: new Date().toISOString(),
      pmPrice: { yesBid: pm.price.yes_bid, yesAsk: pm.price.yes_ask },
      kalshiPrice: { yesBid: k.price.yes_bid, yesAsk: k.price.yes_ask },
      spreadPct,
    });
  }

  return results;
}

/** Derive a parent event URL from a Polymarket/Kalshi outcome URL. */
function deriveEventUrl(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    // Polymarket: /market/<outcome> should map to its event page.
    if (url.hostname.includes('polymarket.com')) {
      const parts = url.pathname.split('/');
      if (parts[1] === 'market' && parts.length >= 3) {
        const marketSlug = parts[2];
        // Strip any trailing query params.
        return `https://polymarket.com/event/${marketSlug.split('?')[0]}`;
      }
    }
    // Kalshi: /markets/<event>/<ticker> shares prefix.
    if (url.hostname.includes('kalshi.com')) {
      const parts = url.pathname.split('/');
      if (parts[1] === 'markets' && parts.length >= 3) {
        return `https://kalshi.com/markets/${parts[2]}`;
      }
    }
  } catch { /* ignore invalid URLs */ }
  return sourceUrl;
}

/** Derive a common parent title from two outcome titles. */
function deriveEventTitle(pmTitle: string, kTitle: string): string | null {
  const a = pmTitle.toLowerCase();
  const b = kTitle.toLowerCase();
  // Simple LCS-ish: find common prefix, then clean up trailing punctuation.
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i > 8) {
    return (pmTitle.slice(0, i).trim().replace(/[^a-zA-Z0-9]+$/, '') || null);
  }
  return null;
}

/* ──────────────────────────── Public API ──────────────────────────── */

export async function getPredictionHuntMarkets(): Promise<PredictionHuntMarket[]> {
  await ensureDir();
  try { return JSON.parse(await fs.readFile(MARKETS_FILE, 'utf-8')); } catch { return []; }
}

export async function savePredictionHuntMarkets(markets: PredictionHuntMarket[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(MARKETS_FILE, JSON.stringify(markets, null, 2));
}

export async function addPredictionHuntMarkets(newMarkets: PredictionHuntMarket[]): Promise<{ added: number; updated: number; duplicates: number }> {
  const existing = await getPredictionHuntMarkets();
  const key = (m: PredictionHuntMarket) => `${m.title}|${m.kalshiUrl || ''}|${m.polymarketUrl || ''}|${m.eventDate || ''}`;
  const seen = new Set(existing.map(key));

  let added = 0, duplicates = 0;
  for (const nm of newMarkets) {
    const k = key(nm);
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k); existing.push(nm); added++;
  }
  existing.sort((a, b) => {
    const da = a.eventDate ? new Date(a.eventDate).getTime() : Infinity;
    const db = b.eventDate ? new Date(b.eventDate).getTime() : Infinity;
    return da - db;
  });
  await savePredictionHuntMarkets(existing);
  return { added, updated: 0, duplicates };
}

export interface SyncLog {
  startedAt: string; finishedAt: string;
  categoriesTried: string[]; categoriesSucceeded: string[]; categoriesFailed: { category: string; error: string }[];
  totalFetched: number; added: number; updated: number; duplicates: number; currentMarketCount: number;
}

export async function runFullSync(): Promise<SyncLog> {
  const log: SyncLog = {
    startedAt: new Date().toISOString(), finishedAt: '',
    categoriesTried: [...CATEGORIES], categoriesSucceeded: [], categoriesFailed: [],
    totalFetched: 0, added: 0, updated: 0, duplicates: 0, currentMarketCount: 0,
  };

  // Fetch all categories for both platforms
  const [pmMarkets, kMarkets] = await Promise.all([
    fetchAllPlatformMarkets('polymarket'),
    fetchAllPlatformMarkets('kalshi'),
  ]);

  const pmByCat = new Map<string, PhV2Market[]>();
  for (const m of pmMarkets) {
    const list = pmByCat.get(m.category) || [];
    list.push(m); pmByCat.set(m.category, list);
  }

  log.categoriesSucceeded.push(`polymarket:${pmMarkets.length}`, `kalshi:${kMarkets.length}`);
  log.totalFetched = pmMarkets.length + kMarkets.length;

  const matches = buildMatches(pmMarkets, kMarkets);
  const stats = await addPredictionHuntMarkets(matches);
  log.added = stats.added; log.updated = stats.updated; log.duplicates = stats.duplicates;
  log.currentMarketCount = (await getPredictionHuntMarkets()).length;
  log.finishedAt = new Date().toISOString();

  await fs.writeFile(SYNC_LOG_FILE, JSON.stringify(log, null, 2));
  return log;
}

export async function getLatestSyncLog(): Promise<SyncLog | null> {
  await ensureDir();
  try { return JSON.parse(await fs.readFile(SYNC_LOG_FILE, 'utf-8')); } catch { return null; }
}

/* ──────────────────────────── Search API ──────────────────────────── */

export interface PhSearchMarket {
  id: string;
  source: string;
  source_url: string | null;
  last_price?: number | null;
  yes_ask?: number | null;
  yes_bid?: number | null;
}

export interface PhSearchGroup {
  group_id: number;
  title: string;
  markets: PhSearchMarket[];
}

export interface PhSearchEvent {
  event_name: string;
  event_type: string;
  event_date: string | null;
  confidence: 'high' | 'medium' | 'low';
  group_count?: number;
  groups: PhSearchGroup[];
}

export interface PhSearchResult {
  success: boolean;
  count: number;
  events: PhSearchEvent[];
}

/** Map of category => search terms for PredictionHunt /v2/matching-markets. */
export const CATEGORY_SEARCH_TERMS: Record<string, string[]> = {
  sports: ['fifa world cup', 'mlb', 'nba', 'nfl', 'tennis', 'olympics', 'ufc', 'formula 1'],
  politics: ['trump', 'congress', 'senate', 'house', 'ukraine', 'putin'],
  election: ['2026 election', 'president', 'governor', 'mayor'],
  entertainment: ['oscars', 'grammy', 'hollywood', 'movie'],
  economics: ['fed', 'rates', 'tariff', 'recession', 'inflation', 'jobs'],
  crypto: ['bitcoin', 'ethereum', 'crypto', 'sec'],
  science: ['nasa', 'spacex', 'climate', 'ai'],
  technology: ['apple', 'nvidia', 'google', 'ai', 'tsmc'],
  weather: ['hurricane', 'temperature', 'storm'],
  international: ['gaza', 'israel', 'china', 'eu', 'nato'],
};

export async function fetchMatchingMarkets(
  query: string,
  options: { maxDays?: number; limit?: number } = {}
): Promise<PhSearchResult> {
  const { maxDays = 365, limit = 200 } = options;
  const url = new URL(`${BASE_URL}/matching-markets`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json', 'X-API-Key': API_KEY },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`matching-markets ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const events: PhSearchEvent[] = (data.events || []).map((e: any) => ({
    event_name: e.title || e.event_name,
    event_type: e.event_type || 'unknown',
    event_date: e.event_date || null,
    confidence: e.confidence === 'high' || e.confidence === 'medium' ? e.confidence : 'medium',
    group_count: e.group_count,
    groups: (e.groups || []).map((g: any) => ({
      group_id: g.group_id,
      title: g.title,
      markets: (g.markets || []).map((m: any) => ({
        id: String(m.id ?? m.market_id ?? ''),
        source: m.source || m.platform || '',
        source_url: m.source_url || null,
        last_price: m.last_price ?? null,
        yes_ask: m.yes_ask ?? null,
        yes_bid: m.yes_bid ?? null,
      })),
    })),
  }));

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + maxDays);

  const filtered = events.filter((e) => {
    if (!e.event_date) return true;
    return new Date(e.event_date).getTime() <= cutoff.getTime();
  });

  return { success: true, count: filtered.length, events: filtered };
}

function toKalshiEventUrl(url: string | null): string | null {
  if (!url) return null;
  // https://kalshi.com/markets/BASE_TICKER/OUTCOME_TICKER -> https://kalshi.com/markets/BASE_TICKER
  const m = url.match(/^(https?:\/\/kalshi\.com\/markets\/[^/]+)\/.+$/);
  return m ? m[1] : url;
}

/** Build unified matched markets from PredictionHunt search events.
 *  Each returned item represents an EVENT that has matched markets across
 *  platforms. We pick the first group (outcome) that contains both a Kalshi
 *  and a Polymarket URL and use those links as the event's entry points.
 *  Kalshi URLs are stripped to the parent event URL.
 *  `maxCount` caps the number of returned events to conserve API credits.
 */
export function buildMatchedMarketsFromSearch(
  events: PhSearchEvent[],
  maxCount?: number
): PredictionHuntMarket[] {
  const results: PredictionHuntMarket[] = [];
  const seenEvents = new Set<string>();

  for (const e of events) {
    // Pick the first group that has both platforms
    const g = e.groups.find(
      (grp) =>
        grp.markets.some((m) => m.source === 'polymarket' && m.source_url) &&
        grp.markets.some((m) => m.source === 'kalshi' && m.source_url)
    );
    if (!g) continue;

    const pm = g.markets.find((m) => m.source === 'polymarket' && m.source_url);
    const k = g.markets.find((m) => m.source === 'kalshi' && m.source_url);
    if (!pm || !k) continue;

    // One row per event, not per outcome
    if (seenEvents.has(e.event_name)) continue;
    seenEvents.add(e.event_name);

    if (maxCount != null && results.length >= maxCount) break;

    const yesAskDiff =
      pm.yes_ask != null && k.yes_ask != null
        ? Math.abs(pm.yes_ask - k.yes_ask)
        : null;

    results.push({
      id: hashMarket(e.event_name, e.event_type),
      eventId: g.group_id,
      groupId: g.group_id,
      title: e.event_name,
      eventType: e.event_type,
      confidence: e.confidence,
      eventDate: e.event_date,
      groupTitle: g.title,
      polymarketUrl: pm.source_url,
      polymarketId: pm.id,
      kalshiUrl: toKalshiEventUrl(k.source_url),
      kalshiId: k.id,
      marketCount: e.groups.length,
      fetchedAt: new Date().toISOString(),
      pmPrice: { yesBid: pm.yes_bid ?? null, yesAsk: pm.yes_ask ?? null },
      kalshiPrice: { yesBid: k.yes_bid ?? null, yesAsk: k.yes_ask ?? null },
      spreadPct: yesAskDiff,
    });
  }

  return results;
}

export async function searchPredictionHunt(
  query: string,
  options: { category?: string; maxDays?: number; limit?: number } = {}
): Promise<PhSearchResult> {
  const { category, maxDays = 365, limit = 500 } = options;
  const url = new URL(`${BASE_URL}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  if (category && category !== 'all') url.searchParams.set('category', category);

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json', 'X-API-Key': API_KEY },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`search ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const events: PhSearchEvent[] = (data.events || []).map((e: any) => ({
    event_name: e.event_name,
    event_type: e.event_type,
    event_date: e.event_date || null,
    confidence: e.confidence === 'high' || e.confidence === 'medium' ? e.confidence : 'medium',
    group_count: e.group_count,
    groups: (e.groups || []).map((g: any) => ({
      group_id: g.group_id,
      title: g.title,
      markets: (g.markets || []).map((m: any) => ({
        id: String(m.id ?? m.market_id ?? ''),
        source: m.source || m.platform || '',
        source_url: m.source_url || null,
        last_price: m.last_price ?? null,
        yes_ask: m.yes_ask ?? null,
        yes_bid: m.yes_bid ?? null,
      })),
    })),
  }));

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + maxDays);

  const filtered = events.filter((e) => {
    if (!e.event_date) return true;
    return new Date(e.event_date).getTime() <= cutoff.getTime();
  });

  return { success: true, count: filtered.length, events: filtered };
}
