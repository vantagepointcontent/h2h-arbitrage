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
  const tmpFile = `${DATA_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(matches, null, 2));
  try {
    await fs.rename(tmpFile, DATA_FILE);
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }
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
  const { restoreCoupling } = await import('./coupling-store');
  await restoreCoupling(match.kalshiTicker, match.pmConditionId);
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
  const target = matches.find(m => m.id === id);
  if (!target) {
    const { wasDeletedByManualMatchId } = await import('./coupling-store');
    return wasDeletedByManualMatchId(id);
  }
  const filtered = matches.filter(m => m.id !== id);
  const { deleteCoupling } = await import('./coupling-store');
  await deleteCoupling({ ...target, manualMatchId: target.id });
  await writeMatchesAtomic(filtered);
  return true;
}
