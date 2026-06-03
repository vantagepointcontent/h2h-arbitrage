import { promises as fs } from 'fs';
import path from 'path';

/* ──────────────────────────── Types ──────────────────────────── */

export interface PredictionHuntMarket {
  id: string;                    // {eventId}-{groupId} hash
  eventId: number;
  groupId: number;
  title: string;
  eventType: string;
  confidence: 'high' | 'medium';
  eventDate: string | null;      // ISO date string
  groupTitle: string;
  polymarketUrl: string | null;
  polymarketId: string | null;
  kalshiUrl: string | null;
  kalshiId: string | null;
  marketCount: number;          // antal matchade plattformar
  fetchedAt: string;             // ISO timestamp
}

/* ──────────────────────────── Config ──────────────────────────── */

const DATA_DIR = path.join(process.cwd(), 'data');
const MARKETS_FILE = path.join(DATA_DIR, 'predictionhunt-markets.json');
const SYNC_LOG_FILE = path.join(DATA_DIR, 'predictionhunt-sync.log.json');

const PREDICTIONHUNT_API_URL = 'https://www.predictionhunt.com/api/v2/matching-markets';
const API_KEY = process.env.PREDICTIONHUNT_API_KEY?.trim() || '';
if (!API_KEY) {
  console.warn('[predictionhunt] PREDICTIONHUNT_API_KEY not set in env');
}

/* Search terms to iterate over. PredictionHunt requires a q param and    
   returns max 10 hits. These cover the landscape pretty well.              */
const SEARCH_TERMS = [
  '2026', '2027', 'trump', 'election', 'president', 'congress',
  'biden', 'gdp', 'inflation', 'fed', 'rates', 'nasdaq', 'sp500',
  'war', 'russia', 'ukraine', 'israel', 'gaza',
  'nba', 'nfl', 'mlb', 'soccer', 'world cup', 'tennis', 'golf',
  'oscars', 'grammy', 'emmy', 'bachelor',
  'california', 'texas', 'florida', 'europe', 'britain', 'france',
  'ai', 'tesla', 'bitcoin', 'crypto', 'ethereum',
  'weather', 'hurricane', 'temperature', 'storm',
  'meta', 'apple', 'google', 'amazon', 'microsoft',
  'oil', 'gas', 'energy', 'climate',
];

/* ──────────────────────────── Helpers ──────────────────────────── */

async function ensureDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}

function hashMarket(e: any, g: any): string {
  // Stable id based on event + group (so each sub-market within an event gets its own id)
  const base = `${e.title || ''}|${g.group_id || 0}|${g.title || ''}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) {
    h = ((h << 5) - h + base.charCodeAt(i)) | 0;
  }
  return `${Math.abs(h)}-${g.group_id || 0}`;
}

function extractMarketUrls(group: any): { pmUrl: string | null; pmId: string | null; kUrl: string | null; kId: string | null; count: number } {
  const markets = group.markets || [];
  let pmUrl: string | null = null;
  let pmId: string | null = null;
  let kUrl: string | null = null;
  let kId: string | null = null;

  for (const m of markets) {
    if (m.source === 'polymarket' && m.source_url && !pmUrl) {
      pmUrl = m.source_url;
      pmId = m.id || null;
    }
    if (m.source === 'kalshi' && m.source_url && !kUrl) {
      kUrl = m.source_url;
      kId = m.id || null;
    }
  }

  return {
    pmUrl,
    pmId,
    kUrl,
    kId,
    count: markets.length,
  };
}

/* ──────────────────────────── API Call ──────────────────────────── */

export async function fetchMatchingMarkets(term: string): Promise<PredictionHuntMarket[]> {
  if (!API_KEY) {
    throw new Error('PREDICTIONHUNT_API_KEY not configured');
  }

  const url = new URL(PREDICTIONHUNT_API_URL);
  url.searchParams.set('q', term);

  const res = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'X-API-Key': API_KEY,
    },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PredictionHunt API returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.success || !Array.isArray(data.events)) {
    return [];
  }

  const results: PredictionHuntMarket[] = [];
  for (const event of data.events) {
    if (!Array.isArray(event.groups)) continue;
    for (const group of event.groups) {
      const { pmUrl, pmId, kUrl, kId, count } = extractMarketUrls(group);
      // Skip if neither platform URL is present (unusable)
      if (!pmUrl && !kUrl) continue;

      results.push({
        id: hashMarket(event, group),
        eventId: event.id || hashMarket(event, group).split('-')[0],
        groupId: group.group_id || 0,
        title: event.title || group.title || 'Untitled',
        eventType: event.event_type || 'unknown',
        confidence: event.confidence || 'medium',
        eventDate: event.event_date || null,
        groupTitle: group.title || '',
        polymarketUrl: pmUrl,
        polymarketId: pmId,
        kalshiUrl: kUrl,
        kalshiId: kId,
        marketCount: count,
        fetchedAt: new Date().toISOString(),
      });
    }
  }

  return results;
}

/* ──────────────────────────── Persistence ──────────────────────────── */

export async function getPredictionHuntMarkets(): Promise<PredictionHuntMarket[]> {
  await ensureDir();
  try {
    const data = await fs.readFile(MARKETS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function savePredictionHuntMarkets(markets: PredictionHuntMarket[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(MARKETS_FILE, JSON.stringify(markets, null, 2));
}

export async function addPredictionHuntMarkets(newMarkets: PredictionHuntMarket[]): Promise<{ added: number; updated: number; duplicates: number }> {
  const existing = await getPredictionHuntMarkets();

  // Deduplicate by (title + kalshiUrl + polymarketUrl + eventDate) — same market from different group ids
  const key = (m: PredictionHuntMarket) => `${m.title}|${m.kalshiUrl || ''}|${m.polymarketUrl || ''}|${m.eventDate || ''}`;

  const seen = new Set<string>(existing.map(key));

  let added = 0;
  let updated = 0;
  let duplicates = 0;

  for (const nm of newMarkets) {
    const k = key(nm);
    if (seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    existing.push(nm);
    added++;
  }

  // Sort: expiry soonest first, then by title
  existing.sort((a, b) => {
    const da = a.eventDate ? new Date(a.eventDate).getTime() : Infinity;
    const db = b.eventDate ? new Date(b.eventDate).getTime() : Infinity;
    if (da !== db) return da - db;
    return a.title.localeCompare(b.title);
  });

  await savePredictionHuntMarkets(existing);
  return { added, updated, duplicates };
}

export async function deletePredictionHuntMarket(id: string): Promise<boolean> {
  const markets = await getPredictionHuntMarkets();
  const filtered = markets.filter(m => m.id !== id);
  if (filtered.length === markets.length) return false;
  await savePredictionHuntMarkets(filtered);
  return true;
}

/* ──────────────────────────── Sync ──────────────────────────── */

export interface SyncLog {
  startedAt: string;
  finishedAt: string;
  termsTried: string[];
  termsSucceeded: string[];
  termsFailed: { term: string; error: string }[];
  totalFetched: number;
  added: number;
  updated: number;
  duplicates: number;
  currentMarketCount: number;
}

export async function runFullSync(): Promise<SyncLog> {
  const log: SyncLog = {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    termsTried: [...SEARCH_TERMS],
    termsSucceeded: [],
    termsFailed: [],
    totalFetched: 0,
    added: 0,
    updated: 0,
    duplicates: 0,
    currentMarketCount: 0,
  };

  const allFetched: PredictionHuntMarket[] = [];

  for (const term of SEARCH_TERMS) {
    try {
      const ms = await fetchMatchingMarkets(term);
      log.termsSucceeded.push(term);
      allFetched.push(...ms);
      log.totalFetched += ms.length;
    } catch (err: any) {
      log.termsFailed.push({ term, error: err.message });
    }

    // Rate-limit respect: 150ms between calls
    await new Promise(r => setTimeout(r, 150));
  }

  const stats = await addPredictionHuntMarkets(allFetched);
  log.added = stats.added;
  log.updated = stats.updated;
  log.duplicates = stats.duplicates;
  log.currentMarketCount = (await getPredictionHuntMarkets()).length;
  log.finishedAt = new Date().toISOString();

  await ensureDir();
  await fs.writeFile(SYNC_LOG_FILE, JSON.stringify(log, null, 2));
  return log;
}

export async function getLatestSyncLog(): Promise<SyncLog | null> {
  await ensureDir();
  try {
    const data = await fs.readFile(SYNC_LOG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}
