import { promises as fs } from 'fs';
import path from 'path';

const DATA_FILE = path.join(process.cwd(), 'data', 'saved-markets.json');

export interface LastScanResult {
  bestRoiPct: number;      // t.ex. 26.5
  bestProfit: number;       // t.ex. 265
  strategy: string;         // "Buy YES Kalshi + NO PM"
  outcomeCount: number;
  matchedCount: number;
  kalshiCount: number;
  pmCount: number;
  scannedAt: string;        // ISO timestamp
}

export interface SavedMarket {
  id: string;
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  category?: string; // e.g. "Politics", "Temperature", "Finances", "Mentions", "Sports"
  createdAt: string;
  expiryDate?: string | null; // ISO timestamp
  lastScanResult?: LastScanResult | null;
}

async function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

export async function getSavedMarkets(): Promise<SavedMarket[]> {
  try {
    await ensureDir();
    const data = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function addSavedMarket(market: Omit<SavedMarket, 'id' | 'createdAt' | 'lastScanResult'>): Promise<SavedMarket> {
  const markets = await getSavedMarkets();
  const newMarket: SavedMarket = {
    ...market,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
    expiryDate: null,
    lastScanResult: null,
  };
  markets.push(newMarket);
  await ensureDir();
  await fs.writeFile(DATA_FILE, JSON.stringify(markets, null, 2));
  return newMarket;
}

export async function updateSavedMarketScanResult(id: string, result: LastScanResult): Promise<void> {
  const markets = await getSavedMarkets();
  const idx = markets.findIndex(m => m.id === id);
  if (idx >= 0) {
    markets[idx].lastScanResult = result;
    await ensureDir();
    await fs.writeFile(DATA_FILE, JSON.stringify(markets, null, 2));
  }
}

export async function updateSavedMarket(id: string, updates: Partial<Pick<SavedMarket, 'eventTitle' | 'expiryDate' | 'category'>>): Promise<boolean> {
  const markets = await getSavedMarkets();
  const idx = markets.findIndex(m => m.id === id);
  if (idx < 0) return false;
  if (updates.eventTitle !== undefined) markets[idx].eventTitle = updates.eventTitle;
  if (updates.expiryDate !== undefined) markets[idx].expiryDate = updates.expiryDate || null;
  if (updates.category !== undefined) markets[idx].category = updates.category;
  await ensureDir();
  await fs.writeFile(DATA_FILE, JSON.stringify(markets, null, 2));
  return true;
}

export async function deleteSavedMarket(id: string): Promise<boolean> {
  const markets = await getSavedMarkets();
  const filtered = markets.filter(m => m.id !== id);
  if (filtered.length === markets.length) return false;
  await fs.writeFile(DATA_FILE, JSON.stringify(filtered, null, 2));
  return true;
}
