import { promises as fs } from 'fs';
import path from 'path';

const DATA_FILE = path.join(process.cwd(), 'data', 'saved-markets.json');

export interface LastScanResult {
  bestRoiPct: number;      // t.ex. 26.5 (for backward compat / display)
  bestProfit: number;       // t.ex. 265
  strategy: string;         // "Buy YES Kalshi + NO PM"
  outcomeCount: number;
  matchedCount: number;
  kalshiCount: number;
  pmCount: number;
  scannedAt: string;        // ISO timestamp
  allArbs?: {               // ALL positive arbitrage opportunities in this scan
    artist: string;
    roiPct: number;
    expectedProfit: number;
    strategy: string;
  }[];
}

export interface SavedMarket {
  id: string;
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  category?: string; // e.g. "Politics", "Temperature", "Finances", "Mentions", "Sports"
  createdAt: string;
  expiryDate?: string | null; // ISO timestamp
  favorite?: boolean;         // user-starred for quick access
  lastScanResult?: LastScanResult | null;
}

async function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

async function writeSavedMarkets(markets: SavedMarket[]): Promise<void> {
  // Atomic write via temp + rename, with retry on race-condition ENOENT.
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(markets, null, 2));

  let renamed = false;
  let attempts = 0;
  while (!renamed && attempts < 5) {
    try {
      await fs.rename(tmp, DATA_FILE);
      renamed = true;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        attempts += 1;
        await sleep(50 + Math.random() * 100);
      } else {
        throw err;
      }
    }
  }

  if (!renamed) {
    // Fallback: direct overwrite if rename keeps failing
    await fs.writeFile(DATA_FILE, JSON.stringify(markets, null, 2));
  }

  // Keep a rolling backup (last known good state)
  try {
    await fs.copyFile(DATA_FILE, `${DATA_FILE}.bak`);
  } catch {}
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export async function getSavedMarkets(): Promise<SavedMarket[]> {
  try {
    await ensureDir();
    const data = await fs.readFile(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    // Defensive: if someone wrote [] by mistake, check backup
    if (Array.isArray(parsed) && parsed.length === 0) {
      try {
        const backup = await fs.readFile(`${DATA_FILE}.bak`, 'utf-8');
        const parsedBackup = JSON.parse(backup);
        if (Array.isArray(parsedBackup) && parsedBackup.length > 0) {
          return parsedBackup;
        }
      } catch {}
    }
    return parsed;
  } catch {
    return [];
  }
}

/** Normalize a URL for identity comparison (strip trailing slash + query, lowercase) */
function normalizeUrl(url: string): string {
  return (url || '').split('?')[0].replace(/\/$/, '').toLowerCase();
}

export async function addSavedMarket(market: Omit<SavedMarket, 'id' | 'createdAt' | 'lastScanResult'>): Promise<SavedMarket> {
  const markets = await getSavedMarkets();
  const normK = normalizeUrl(market.kalshiUrl);
  const normP = normalizeUrl(market.polymarketUrl);
  // Check by URL first (more reliable than title)
  const urlExists = markets.some(m =>
    normalizeUrl(m.kalshiUrl) === normK || normalizeUrl(m.polymarketUrl) === normP
  );
  // Fall back to title check for legacy entries
  const nameExists = markets.some(m => m.eventTitle.toLowerCase().trim() === (market.eventTitle || 'Untitled').toLowerCase().trim());
  if (urlExists || nameExists) {
    throw new Error(`Market already exists: "${market.eventTitle || 'Untitled'}"`);
  }
  const newMarket: SavedMarket = {
    ...market,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
    lastScanResult: null,
  };
  markets.push(newMarket);
  await writeSavedMarkets(markets);
  return newMarket;
}

/** Upsert a saved market: update in-place if exists (by URL), or create if new.
 * Preserves favorite status and other user-set fields on update. */
export async function upsertSavedMarket(input: {
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  category?: string;
  expiryDate?: string | null;
  lastScanResult?: LastScanResult | null;
}): Promise<SavedMarket> {
  const markets = await getSavedMarkets();
  const normK = normalizeUrl(input.kalshiUrl);
  const normP = normalizeUrl(input.polymarketUrl);

  const idx = markets.findIndex(m =>
    normalizeUrl(m.kalshiUrl) === normK || normalizeUrl(m.polymarketUrl) === normP
  );

  if (idx >= 0) {
    // Update in-place — preserve favorite status
    const existing = markets[idx];
    markets[idx] = {
      ...existing,
      eventTitle: input.eventTitle,
      category: input.category ?? existing.category,
      expiryDate: input.expiryDate ?? existing.expiryDate,
      lastScanResult: input.lastScanResult ?? existing.lastScanResult,
    };
    await writeSavedMarkets(markets);
    return markets[idx];
  }

  // New market — create
  const newMarket: SavedMarket = {
    kalshiUrl: input.kalshiUrl,
    polymarketUrl: input.polymarketUrl,
    eventTitle: input.eventTitle,
    category: input.category,
    expiryDate: input.expiryDate,
    favorite: false,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
    lastScanResult: input.lastScanResult ?? null,
  };
  markets.push(newMarket);
  await writeSavedMarkets(markets);
  return newMarket;
}

export async function updateSavedMarketScanResult(id: string, result: LastScanResult): Promise<void> {
  const markets = await getSavedMarkets();
  const idx = markets.findIndex(m => m.id === id);
  if (idx >= 0) {
    markets[idx].lastScanResult = result;
    await writeSavedMarkets(markets);
  }
}

export async function updateSavedMarket(id: string, updates: Partial<Pick<SavedMarket, 'eventTitle' | 'expiryDate' | 'category'>>): Promise<boolean> {
  const markets = await getSavedMarkets();
  const idx = markets.findIndex(m => m.id === id);
  if (idx < 0) return false;
  if (updates.eventTitle !== undefined) markets[idx].eventTitle = updates.eventTitle;
  if (updates.expiryDate !== undefined) markets[idx].expiryDate = updates.expiryDate || null;
  if (updates.category !== undefined) markets[idx].category = updates.category;
  await writeSavedMarkets(markets);
  return true;
}

export async function deleteSavedMarket(id: string): Promise<boolean> {
  const markets = await getSavedMarkets();
  const filtered = markets.filter(m => m.id !== id);
  if (filtered.length === markets.length) return false;
  await writeSavedMarkets(filtered);
  return true;
}
