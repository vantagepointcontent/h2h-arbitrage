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
  marketId?: string;
  orientation?: 'same' | 'inverted';
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
  const store = await import('./coupling-store');
  const canonical = await store.getCanonicalManualMatches();
  if (canonical.length > 0) return canonical;
  let legacy: ManualMatch[] = [];
  try { legacy = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8')); } catch {}
  if (await store.hasManualCouplingHistory()) {
    await store.importActiveLegacyManualMatches(legacy);
    return store.getCanonicalManualMatches();
  }
  for (const match of legacy) {
    await store.mutateManualCoupling({
      action: 'create', marketId: match.marketId, manualMatchId: match.id,
      kalshiTicker: match.kalshiTicker, pmConditionId: match.pmConditionId,
      artist: match.kalshiTitle || match.pmTitle, manualMatch: match,
    });
  }
  return legacy.length > 0 ? store.getCanonicalManualMatches() : [];
}

async function refreshMirror(): Promise<void> {
  try { await writeMatchesAtomic(await getManualMatches()); } catch (error) {
    console.error('[manual-matches] JSON mirror update failed; SQLite remains authoritative:', error);
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
  const { mutateManualCoupling } = await import('./coupling-store');
  await mutateManualCoupling({
    action: 'create', marketId: match.marketId, manualMatchId: newMatch.id,
    kalshiTicker: match.kalshiTicker, pmConditionId: match.pmConditionId,
    artist: match.kalshiTitle || match.pmTitle,
    manualMatch: newMatch,
  });
  await refreshMirror();
  return newMatch;
}

export async function deleteManualMatch(id: string): Promise<boolean> {
  const matches = await getManualMatches();
  const target = matches.find(m => m.id === id);
  if (!target) return false;
  const { mutateManualCoupling } = await import('./coupling-store');
  await mutateManualCoupling({
    action: 'delete', marketId: target.marketId, manualMatchId: target.id,
    kalshiTicker: target.kalshiTicker, pmConditionId: target.pmConditionId,
    artist: target.kalshiTitle || target.pmTitle,
  });
  await refreshMirror();
  return true;
}
