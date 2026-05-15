import { promises as fs } from 'fs';
import path from 'path';

const DATA_FILE = path.join(process.cwd(), 'data', 'saved-markets.json');

export interface SavedMarket {
  id: string;
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  createdAt: string;
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

export async function addSavedMarket(market: Omit<SavedMarket, 'id' | 'createdAt'>): Promise<SavedMarket> {
  const markets = await getSavedMarkets();
  const newMarket: SavedMarket = {
    ...market,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
  };
  markets.push(newMarket);
  await ensureDir();
  await fs.writeFile(DATA_FILE, JSON.stringify(markets, null, 2));
  return newMarket;
}

export async function deleteSavedMarket(id: string): Promise<boolean> {
  const markets = await getSavedMarkets();
  const filtered = markets.filter(m => m.id !== id);
  if (filtered.length === markets.length) return false;
  await fs.writeFile(DATA_FILE, JSON.stringify(filtered, null, 2));
  return true;
}
