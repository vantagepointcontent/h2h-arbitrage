import { promises as fs } from 'fs';
import path from 'path';

const DATA_FILE = path.join(process.cwd(), 'data', 'decoupled-pairs.json');

export interface DecoupledPair {
  id: string;
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle: string;
  pmTitle: string;
  decoupledAt: string;
}

async function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

async function writeFileAtomic(pairs: DecoupledPair[]) {
  await ensureDir();
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(pairs, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

export async function getDecoupledPairs(): Promise<DecoupledPair[]> {
  try {
    await ensureDir();
    const data = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function addDecoupledPair(pair: Omit<DecoupledPair, 'id' | 'decoupledAt'>): Promise<DecoupledPair> {
  const pairs = await getDecoupledPairs();
  const exists = pairs.some(p =>
    p.kalshiTicker === pair.kalshiTicker && p.pmConditionId === pair.pmConditionId
  );
  if (exists) throw new Error('Pair already decoupled');
  const entry: DecoupledPair = {
    ...pair,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    decoupledAt: new Date().toISOString(),
  };
  pairs.push(entry);
  await writeFileAtomic(pairs);
  return entry;
}

export async function removeDecoupledPair(id: string): Promise<boolean> {
  const pairs = await getDecoupledPairs();
  const filtered = pairs.filter(p => p.id !== id);
  if (filtered.length === pairs.length) return false;
  await writeFileAtomic(filtered);
  return true;
}

/**
 * Split any auto-matched pairs that the user has explicitly decoupled.
 * Returns a new array where decoupled pairs are broken into separate
 * Kalshi-only and Polymarket-only outcomes.
 */
export function applyDecoupledPairs<T extends {
  kalshi: { ticker: string } | null;
  polymarket: { conditionId: string; marketId?: string } | null;
  arbitrage: Record<string, any>;
  artist: string;
}>(outcomes: T[], decoupledPairs: DecoupledPair[]): T[] {
  if (!decoupledPairs.length) return outcomes;
  const decoupledSet = new Set(decoupledPairs.map(d => `${d.kalshiTicker}|${d.pmConditionId}`));
  const result: T[] = [];
  for (const o of outcomes) {
    if (o.kalshi && o.polymarket && decoupledSet.has(`${o.kalshi.ticker}|${o.polymarket.conditionId}`)) {
      // Split into two separate outcomes
      const kalshiOnly: T = {
        ...o,
        polymarket: null,
        arbitrage: { ...o.arbitrage, strategy: 'No arb', expectedProfit: 0, roiPct: 0, apyPct: 0, kalshiStake: 0, pmStake: 0 },
      };
      const pmOnly: T = {
        ...o,
        kalshi: null,
        artist: o.polymarket!.marketId || o.polymarket!.conditionId,
        arbitrage: { ...o.arbitrage, strategy: 'No arb', expectedProfit: 0, roiPct: 0, apyPct: 0, kalshiStake: 0, pmStake: 0 },
      };
      result.push(kalshiOnly, pmOnly);
    } else {
      result.push(o);
    }
  }
  return result;
}