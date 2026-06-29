import { promises as fs, writeFileSync as _writeFileSync, readFileSync as _readFileSync, existsSync as _existsSync, mkdirSync as _mkdirSync } from 'fs';
import path from 'path';
import { getPredictionHuntMarkets, PredictionHuntMarket } from './predictionhunt';
import { getSavedMarkets, addSavedMarket, upsertSavedMarket } from './persistence';
import { rateLimiters } from './rate-limiter';

/* ──────────────────────────── Types ──────────────────────────── */

export interface CategoryScanRecord {
  category: string;
  lastScannedAt: string; // ISO timestamp
  marketsAdded: number;
}

export interface AutoDiscoveryState {
  paused: boolean;
  scanRecords: CategoryScanRecord[]; // Recent scan history
  lastScanAt: string | null; // When the last auto-scan ran
  totalMarketsAdded: number;
}

/* ──────────────────────────── Config ──────────────────────────── */

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'auto-discovery-state.json');
const SPREAD_THRESHOLD_PCT = 14; // Auto-add markets with spread < 14%
export const SCAN_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const MAX_SCAN_RECORDS = 50; // Keep last N records

const PLATFORMS = ['polymarket', 'kalshi'];
const BASE_URL = 'https://www.predictionhunt.com/api/v2';
const API_KEY = (process.env.PREDICTIONHUNT_API_KEY || '').trim();
const CATEGORIES = [
  'sports', 'politics', 'election', 'entertainment', 'economics',
  'crypto', 'science', 'technology', 'weather', 'international',
];

/* ──────────────────────────── Helpers ──────────────────────────── */

async function ensureDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}

function loadState(): AutoDiscoveryState {
  try {
    const raw = _readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {
      paused: false,
      scanRecords: [],
      lastScanAt: null,
      totalMarketsAdded: 0,
    };
  }
}

function saveState(state: AutoDiscoveryState): void {
  _writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Pick a random category that hasn't been scanned recently.
 * Priority: categories not scanned in the last 6 hours > oldest scanned > any. */
function pickNextCategory(scanRecords: CategoryScanRecord[]): string {
  const now = Date.now();
  const sixHoursAgo = now - 6 * 60 * 60 * 1000;

  const uncategorized = CATEGORIES.filter(cat =>
    !scanRecords.some(r => r.category === cat && new Date(r.lastScannedAt).getTime() > sixHoursAgo)
  );

  if (uncategorized.length > 0) {
    return uncategorized[Math.floor(Math.random() * uncategorized.length)];
  }

  // Fall back to the least recently scanned
  if (scanRecords.length > 0) {
    const sorted = [...scanRecords].sort((a, b) =>
      new Date(a.lastScannedAt).getTime() - new Date(b.lastScannedAt).getTime()
    );
    return sorted[0].category;
  }

  return CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
}

/** Normalize market title for matching (same as predictionhunt.ts) */
function normalizeTitle(t: string): string {
  return t.toLowerCase()
    .replace(/[.,/#!$%\\^&\\*;:{}=_`~()-]/g, '')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Calculate spread percentage between PM and Kalshi prices.
 * Returns undefined if prices are missing. */
function calcSpreadPct(
  pmYesAsk: number | null | undefined,
  kalshiYesBid: number | null | undefined,
): number | undefined {
  if (pmYesAsk == null || kalshiYesBid == null || pmYesAsk <= 0 || kalshiYesBid <= 0) {
    return undefined;
  }
  const avg = (pmYesAsk + kalshiYesBid) / 2;
  if (avg === 0) return undefined;
  return Math.abs(pmYesAsk - kalshiYesBid) / avg * 100;
}

/* ──────────────────────────── API ──────────────────────────── */

/** Fetch markets for a specific category from one platform. */
async function fetchCategoryMarkets(platform: string, category: string): Promise<any[]> {
  const url = new URL(`${BASE_URL}/markets`);
  url.searchParams.set('platform', platform);
  url.searchParams.set('status', 'active');
  url.searchParams.set('limit', '500');
  url.searchParams.set('category', category);

  const res = await rateLimiters.predictionhunt.execute(() =>
    fetch(url.toString(), {
      headers: { 'Accept': 'application/json', 'X-API-Key': API_KEY },
    }),
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${platform}/${category} ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.markets?.map((m: any) => ({
    id: m.id,
    title: m.title,
    platform: m.platform,
    source_url: m.source_url,
    category: m.category || category,
    expiration_date: m.expiration_date,
    price: m.price || {},
  })) || [];
}

/** Hash a market for consistent ID generation. */
function hashMarket(title: string, cat: string): string {
  const base = `${title}|${cat}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) {
    h = ((h << 5) - h + base.charCodeAt(i)) | 0;
  }
  return `ph-${Math.abs(h)}`;
}

/** Build matched pairs from PM + Kalshi markets with spread data. */
function buildMatchedPairs(pmMarkets: any[], kMarkets: any[]): Array<{
  id: string;
  title: string;
  category: string;
  polymarketUrl: string | null;
  kalshiUrl: string | null;
  eventDate: string | null;
  spreadPct: number | undefined;
}> {
  const kMap = new Map<string, any>();
  for (const k of kMarkets) {
    const nt = normalizeTitle(k.title);
    if (!kMap.has(nt)) kMap.set(nt, k);
  }

  const results = [];
  const seen = new Set<string>();

  for (const pm of pmMarkets) {
    const nt = normalizeTitle(pm.title);
    const match = kMap.get(nt);
    if (!match) continue;

    const key = `${pm.id}-${match.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const spreadPct = calcSpreadPct(
      pm.price?.yesAsk,
      match.price?.yesBid,
    );

    results.push({
      id: hashMarket(pm.title, pm.category),
      title: pm.title,
      category: pm.category,
      polymarketUrl: pm.source_url,
      kalshiUrl: match.source_url,
      eventDate: pm.expiration_date || match.expiration_date || null,
      spreadPct,
    });
  }

  return results;
}

/* ──────────────────────────── Scheduler (eager-start) ────────────── */

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;

/** Start the 3-hour background scheduler. Idempotent — safe to call multiple times. */
export function startScheduler(): void {
  if (schedulerRunning) return;
  schedulerRunning = true;

  schedulerTimer = setInterval(async () => {
    try {
      const state = loadState();
      if (state.paused) return;

      const result = await runAutoDiscovery();
      if (result.added > 0) {
        console.log(
          `[auto-discovery] Scanned "${result.category}": ${result.added} new markets added`
        );
      }
    } catch (err: any) {
      console.error('[auto-discovery] Scheduled scan failed:', err.message);
    }
  }, SCAN_INTERVAL_MS);

  console.log(`[auto-discovery] Scheduler started (interval: ${SCAN_INTERVAL_MS / 3600000}h)`);
}

/** Stop the background scheduler. */
export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerRunning = false;
}

/** Check if the scheduler is currently running. */
export function isSchedulerRunning(): boolean {
  return schedulerRunning;
}

// Eager-start: begin scheduler as soon as this module loads on the server.
// This ensures the 3-hour cycle starts without waiting for an API call.
startScheduler();

/* ──────────────────────────── Public API ──────────────────────────── */

export function getState(): AutoDiscoveryState {
  return loadState();
}

export function setState(state: AutoDiscoveryState): void {
  saveState(state);
}

export function togglePause(paused: boolean): AutoDiscoveryState {
  const state = loadState();
  state.paused = paused;
  saveState(state);
  return state;
}

export function isPaused(): boolean {
  return loadState().paused;
}

/** Get all available categories. */
export function getCategories(): string[] {
  return [...CATEGORIES];
}

/**
 * Run one auto-discovery cycle:
 * 1. Pick a category not scanned recently
 * 2. Fetch PM + Kalshi markets for that category
 * 3. Match pairs, filter by spread threshold
 * 4. Auto-add qualifying markets not already saved
 * 5. Update scan records
 *
 * Returns { category, added, skipped, spreadThreshold, scanRecord }.
 */
export async function runAutoDiscovery(): Promise<{
  category: string;
  added: number;
  skipped: number;
  errors: string[];
  scanRecord: CategoryScanRecord | null;
}> {
  const state = loadState();

  // Check pause
  if (state.paused) {
    return { category: '-', added: 0, skipped: 0, errors: ['Auto-discovery is paused'], scanRecord: null };
  }

  const category = pickNextCategory(state.scanRecords);
  const errors: string[] = [];
  let added = 0;
  let skipped = 0;

  try {
    // Fetch markets for this category from both platforms
    const [pmMarkets, kMarkets] = await Promise.all([
      fetchCategoryMarkets('polymarket', category).catch((e: Error) => {
        errors.push(`PM ${category}: ${e.message}`);
        return [];
      }),
      fetchCategoryMarkets('kalshi', category).catch((e: Error) => {
        errors.push(`Kalshi ${category}: ${e.message}`);
        return [];
      }),
    ]);

    const pairs = buildMatchedPairs(pmMarkets, kMarkets);

    // Get existing saved markets to avoid duplicates
    const savedMarkets = await getSavedMarkets();
    const savedTitles = new Set(savedMarkets.map(m => m.eventTitle.toLowerCase().trim()));

    // Filter by spread threshold and check if already saved
    const candidates = pairs.filter(p => {
      if (!p.polymarketUrl || !p.kalshiUrl) return false;
      if (p.spreadPct === undefined || p.spreadPct >= SPREAD_THRESHOLD_PCT) return false;
      if (savedTitles.has(p.title.toLowerCase().trim())) return false;
      return true;
    });

    // Auto-save qualifying markets (upsert: refresh existing, add new)
    for (const candidate of candidates) {
      try {
        await upsertSavedMarket({
          kalshiUrl: candidate.kalshiUrl!,
          polymarketUrl: candidate.polymarketUrl!,
          eventTitle: candidate.title,
          category: candidate.category,
          expiryDate: candidate.eventDate || null,
        });
        added++;
      } catch (e: any) {
        // Unexpected error — skip
        skipped++;
      }
    }

    // Update scan record
    const record: CategoryScanRecord = {
      category,
      lastScannedAt: new Date().toISOString(),
      marketsAdded: added,
    };
    state.scanRecords.push(record);
    if (state.scanRecords.length > MAX_SCAN_RECORDS) {
      state.scanRecords = state.scanRecords.slice(-MAX_SCAN_RECORDS);
    }
    state.lastScanAt = new Date().toISOString();
    state.totalMarketsAdded += added;
    saveState(state);

    return { category, added, skipped, errors, scanRecord: record };
  } catch (e: any) {
    errors.push(`Unexpected error: ${e.message}`);
    return { category, added, skipped, errors, scanRecord: null };
  }
}
