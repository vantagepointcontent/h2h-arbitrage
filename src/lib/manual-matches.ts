import { promises as fs } from 'fs';
import path from 'path';

const DATA_FILE = path.join(process.cwd(), 'data', 'manual-matches.json');

export interface ManualMatch {
  id: string;
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle: string;
  pmTitle: string;
  kalshiUrl?: string;
  polymarketUrl?: string;
  createdAt: string;
}

async function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

async function writeMatchesAtomic(matches: ManualMatch[]): Promise<void> {
  await ensureDir();
  const tmpFile = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(matches, null, 2));
  await fs.rename(tmpFile, DATA_FILE);
}

export async function getManualMatches(): Promise<ManualMatch[]> {
  try {
    await ensureDir();
    const data = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function addManualMatch(match: Omit<ManualMatch, 'id' | 'createdAt'>): Promise<ManualMatch> {
  const matches = await getManualMatches();

  const exists = matches.some(m =>
    m.kalshiTicker === match.kalshiTicker && m.pmConditionId === match.pmConditionId
  );
  if (exists) throw new Error('Manual match already exists for this pair');

  const newMatch: ManualMatch = {
    ...match,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
  };
  matches.push(newMatch);
  await writeMatchesAtomic(matches);
  return newMatch;
}

export async function deleteManualMatch(id: string): Promise<boolean> {
  const matches = await getManualMatches();
  const filtered = matches.filter(m => m.id !== id);
  if (filtered.length === matches.length) return false;
  await writeMatchesAtomic(filtered);
  return true;
}
