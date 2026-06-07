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
  confidence: 'high' | 'medium';
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
  spreadPct?: number;
}

interface PhV2Market {
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

async function fetchPlatformMarkets(platform: string, category?: string, limit = 500): Promise<PhV2Market[]> {
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
async function fetchAllPlatformMarkets(platform: string): Promise<PhV2Market[]> {
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
  const pmAsk = pmPrice?.yesAsk;
  const kalshiBid = kalshiPrice?.yesBid;
  if (pmAsk == null || kalshiBid == null || pmAsk <= 0 || kalshiBid <= 0) return undefined;
  const avg = (pmAsk + kalshiBid) / 2;
  if (avg === 0) return undefined;
  return Math.abs(pmAsk - kalshiBid) / avg * 100;
}

function buildMatches(pmMarkets: PhV2Market[], kMarkets: PhV2Market[]): PredictionHuntMarket[] {
  const kMap = new Map<string, PhV2Market>();
  for (const k of kMarkets) {
    const nt = normalizeTitle(k.title);
    if (!kMap.has(nt)) kMap.set(nt, k);
  }

  const results: PredictionHuntMarket[] = [];
  const seen = new Set<string>();

  for (const pm of pmMarkets) {
    const nt = normalizeTitle(pm.title);
    const match = kMap.get(nt);
    if (!match) continue;

    const key = `${pm.id}-${match.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const spreadPct = calcSpreadPct(pm.price, match.price);

    results.push({
      id: hashMarket(pm.title, pm.category),
      eventId: pm.id,
      groupId: match.id,
      title: pm.title,
      eventType: pm.category,
      confidence: 'medium',
      eventDate: pm.expiration_date || match.expiration_date || null,
      groupTitle: match.title,
      polymarketUrl: pm.source_url,
      polymarketId: String(pm.id),
      kalshiUrl: match.source_url,
      kalshiId: String(match.id),
      marketCount: 2,
      fetchedAt: new Date().toISOString(),
      pmPrice: pm.price ?? undefined,
      kalshiPrice: match.price ?? undefined,
      spreadPct,
    });
  }

  return results;
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
