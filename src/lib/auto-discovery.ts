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
  /** Pairs awaiting manual review (confidence 50-70) */
  pendingReviews: PendingReviewPair[];
}

export interface ConfidenceBreakdown {
  nameSimilarity: number;   // 0-40
  entityMatch: number;     // 0-30
  categoryMatch: number;   // 0-20
  expiryProximity: number; // 0-10
}

export interface PendingReviewPair {
  id: string;
  title: string;
  category: string;
  polymarketUrl: string | null;
  kalshiUrl: string | null;
  eventDate: string | null;
  spreadPct: number | undefined;
  confidence: number;        // 0-100
  breakdown: ConfidenceBreakdown;
  needsReview: boolean;      // true for 50-70 confidence
  queued: boolean;         // true once approved
  createdAt: string;
}

/* ──────────────────────────── Config ──────────────────────────── */

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'auto-discovery-state.json');
const SPREAD_THRESHOLD_PCT = 14; // Auto-add markets with spread < 14%
export const SCAN_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const MAX_SCAN_RECORDS = 50; // Keep last N records

const CONFIDENCE_AUTO_QUEUE = 70;  // >= 70 → auto-queue
const CONFIDENCE_REVIEW_LOW = 50;  // 50-69 → needs review
// < 50 → skip entirely

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
    const state = JSON.parse(raw);
    // Ensure pendingReviews exists for legacy state files
    if (!state.pendingReviews) state.pendingReviews = [];
    return state;
  } catch {
    return {
      paused: false,
      scanRecords: [],
      lastScanAt: null,
      totalMarketsAdded: 0,
      pendingReviews: [],
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

/** Simple Levenshtein distance for name similarity. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row: number[] = [];
    for (let j = 0; j <= n; j++) row.push(0);
    return row;
  });
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Compute name similarity score (0-40).
 * Exact match = 40, fuzzy = 20-35, partial = 10-20. */
function scoreNameSimilarity(normalizedA: string, normalizedB: string): number {
  if (normalizedA === normalizedB) return 40;
  const dist = levenshtein(normalizedA, normalizedB);
  const maxLen = Math.max(normalizedA.length, normalizedB.length, 1);
  const similarity = 1 - dist / maxLen; // 0-1
  return Math.round(similarity * 35); // Scale to 0-35 for fuzzy
}

/** Extract entities (people, organizations, topics) from a title. */
function extractEntities(title: string): string[] {
  const lower = title.toLowerCase();
  const entities: string[] = [];

  // Common political figures
  const persons = ['trump', 'biden', 'newsom', 'vance', 'harris', 'stevez', 'deSantis', 'pace', 'pace'];
  for (const p of persons) {
    if (lower.includes(p)) entities.push(p);
  }

  // Organizations
  const orgs = ['fed', 'nba', 'nfl', 'nasa', 'apple', 'google', 'amazon', 'tesla', 'microsoft', 'meta'];
  for (const o of orgs) {
    if (lower.includes(o)) entities.push(o);
  }

  // Topics
  const topics = ['bitcoin', 'btc', 'eth', 'ethereum', 'crypto', 'war', 'tariff', 'interest rate'];
  for (const t of topics) {
    if (lower.includes(t)) entities.push(t);
  }

  return entities;
}

/** Compute entity match score (0-30). */
function scoreEntityMatch(titleA: string, titleB: string): number {
  const entitiesA = extractEntities(titleA);
  const entitiesB = extractEntities(titleB);
  if (entitiesA.length === 0 && entitiesB.length === 0) return 15; // No entities → moderate default
  if (entitiesA.length === 0 || entitiesB.length === 0) return 5;

  let common = 0;
  for (const e of entitiesA) {
    if (entitiesB.includes(e)) common++;
  }
  const overlap = common / Math.max(entitiesA.length, entitiesB.length);
  return Math.round(overlap * 30);
}

/** Compute category match score (0-20). Same category = 20, related = 10. */
function scoreCategoryMatch(catA: string, catB: string): number {
  if (catA === catB) return 20;
  // Related categories
  const relatedGroups = [
    ['politics', 'election', 'international'],
    ['sports', 'entertainment'],
    ['economics', 'crypto'],
    ['science', 'technology'],
  ];
  for (const group of relatedGroups) {
    if (group.includes(catA) && group.includes(catB)) return 10;
  }
  return 0;
}

/** Compute expiry proximity score (0-10). Similar dates = higher. */
function scoreExpiryProximity(dateA: string | null, dateB: string | null): number {
  if (!dateA || !dateB) return 5; // Unknown dates → neutral
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  if (isNaN(a) || isNaN(b)) return 5;
  const diffDays = Math.abs(a - b) / (24 * 60 * 60 * 1000);
  if (diffDays <= 1) return 10;
  if (diffDays <= 7) return 8;
  if (diffDays <= 30) return 6;
  if (diffDays <= 90) return 4;
  if (diffDays <= 365) return 2;
  return 0;
}

/**
 * Calculate overall confidence score (0-100) for a discovered pair.
 * Breakdown: name similarity (0-40) + entity match (0-30) + category (0-20) + expiry (0-10).
 */
export function calculateConfidence(
  titleA: string,
  titleB: string,
  categoryA: string,
  categoryB: string,
  dateA: string | null,
  dateB: string | null,
): { confidence: number; breakdown: ConfidenceBreakdown } {
  const normA = normalizeTitle(titleA);
  const normB = normalizeTitle(titleB);

  const nameSim = scoreNameSimilarity(normA, normB);
  const entity = scoreEntityMatch(titleA, titleB);
  const category = scoreCategoryMatch(categoryA, categoryB);
  const expiry = scoreExpiryProximity(dateA, dateB);

  const confidence = nameSim + entity + category + expiry;

  return {
    confidence: Math.min(100, confidence),
    breakdown: {
      nameSimilarity: nameSim,
      entityMatch: entity,
      categoryMatch: category,
      expiryProximity: expiry,
    },
  };
}

/** Determine disposition based on confidence score. */
export function getDisposition(confidence: number): 'auto-queue' | 'review' | 'skip' {
  if (confidence >= CONFIDENCE_AUTO_QUEUE) return 'auto-queue';
  if (confidence >= CONFIDENCE_REVIEW_LOW) return 'review';
  return 'skip';
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

/** Build matched pairs from PM + Kalshi markets with spread data and confidence scores. */
function buildMatchedPairs(pmMarkets: any[], kMarkets: any[]): Array<PendingReviewPair> {
  const kMap = new Map<string, any>();
  for (const k of kMarkets) {
    const nt = normalizeTitle(k.title);
    if (!kMap.has(nt)) kMap.set(nt, k);
  }

  const results: PendingReviewPair[] = [];
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

    const { confidence, breakdown } = calculateConfidence(
      pm.title,
      match.title,
      pm.category,
      match.category,
      pm.expiration_date || null,
      match.expiration_date || null,
    );

    const disposition = getDisposition(confidence);

    results.push({
      id: hashMarket(pm.title, pm.category),
      title: pm.title,
      category: pm.category,
      polymarketUrl: pm.source_url,
      kalshiUrl: match.source_url,
      eventDate: pm.expiration_date || match.expiration_date || null,
      spreadPct,
      confidence,
      breakdown,
      needsReview: disposition === 'review',
      queued: disposition === 'auto-queue',
      createdAt: new Date().toISOString(),
    });
  }

  return results;
}

/* ──────────────────────────── Review Queue ──────────────────────────── */

/** Get all pairs pending manual review (confidence 50-70, not yet approved). */
export function getPendingReviewPairs(): PendingReviewPair[] {
  const state = loadState();
  return state.pendingReviews.filter(p => p.needsReview && !p.queued);
}

/** Approve a pending review pair — queues it to saved markets. */
export async function approveReviewPair(pairId: string): Promise<{ approved: boolean; error?: string }> {
  const state = loadState();
  const idx = state.pendingReviews.findIndex(p => p.id === pairId);
  if (idx === -1) {
    return { approved: false, error: `Pair ${pairId} not found in review queue` };
  }

  const pair = state.pendingReviews[idx];
  if (!pair.needsReview) {
    return { approved: false, error: 'Pair is not in review status' };
  }

  pair.queued = true;
  state.pendingReviews[idx] = pair;
  saveState(state);

  // Add to saved markets
  try {
    await upsertSavedMarket({
      kalshiUrl: pair.kalshiUrl!,
      polymarketUrl: pair.polymarketUrl!,
      eventTitle: pair.title,
      category: pair.category,
      expiryDate: pair.eventDate || null,
    });
    return { approved: true };
  } catch (e: any) {
    return { approved: false, error: e.message };
  }
}

/** Reject a pending review pair — removes it from the queue. */
export function rejectReviewPair(pairId: string): boolean {
  const state = loadState();
  state.pendingReviews = state.pendingReviews.filter(p => p.id !== pairId);
  saveState(state);
  return true;
}

/** Add a discovered pair to the review queue. */
function addToReviewQueue(pair: PendingReviewPair): void {
  const state = loadState();
  // Avoid duplicates
  if (!state.pendingReviews.some(p => p.id === pair.id)) {
    state.pendingReviews.push(pair);
    saveState(state);
  }
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
      if (result.reviewQueued > 0) {
        console.log(
          `[auto-discovery] ${result.reviewQueued} pairs sent to review queue`
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
 * 3. Match pairs, compute confidence scores
 * 4. Auto-add high-confidence pairs (>70) to saved markets
 * 5. Queue medium-confidence pairs (50-70) for review
 * 6. Skip low-confidence pairs (<50)
 * 7. Update scan records
 *
 * Returns { category, added, reviewQueued, skipped, spreadThreshold, scanRecord }.
 */
export async function runAutoDiscovery(): Promise<{
  category: string;
  added: number;
  reviewQueued: number;
  skipped: number;
  errors: string[];
  scanRecord: CategoryScanRecord | null;
}> {
  const state = loadState();

  // Check pause
  if (state.paused) {
    return { category: '-', added: 0, reviewQueued: 0, skipped: 0, errors: ['Auto-discovery is paused'], scanRecord: null };
  }

  const category = pickNextCategory(state.scanRecords);
  const errors: string[] = [];
  let added = 0;
  let reviewQueued = 0;
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

    // Separate pairs by confidence disposition
    for (const pair of pairs) {
      if (!pair.polymarketUrl || !pair.kalshiUrl) {
        skipped++;
        continue;
      }
      if (pair.spreadPct === undefined || pair.spreadPct >= SPREAD_THRESHOLD_PCT) {
        skipped++;
        continue;
      }
      if (savedTitles.has(pair.title.toLowerCase().trim())) {
        skipped++;
        continue;
      }

      if (pair.queued) {
        // High confidence — auto-add
        try {
          await upsertSavedMarket({
            kalshiUrl: pair.kalshiUrl!,
            polymarketUrl: pair.polymarketUrl!,
            eventTitle: pair.title,
            category: pair.category,
            expiryDate: pair.eventDate || null,
          });
          added++;
        } catch {
          skipped++;
        }
      } else if (pair.needsReview) {
        // Medium confidence — add to review queue
        addToReviewQueue(pair);
        reviewQueued++;
      }
      // Low confidence — skip silently
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

    return { category, added, reviewQueued, skipped, errors, scanRecord: record };
  } catch (e: any) {
    errors.push(`Unexpected error: ${e.message}`);
    return { category, added, reviewQueued, skipped, errors, scanRecord: null };
  }
}
