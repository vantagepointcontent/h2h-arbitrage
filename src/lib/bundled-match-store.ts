import { promises as fs } from 'fs';
import path from 'path';
import { allocateBundleBudget, type BundleAllocationResult, type BundleLeg, type OutcomeRange } from './bundled-matches';
import type { BundledMatchInput } from './bundled-match-request';

export interface BundledMatch {
  id: string;
  kind: 'bundle';
  name: string;
  budgetCents: number;
  targetRange: OutcomeRange;
  legs: BundleLeg[];
  preview: BundleAllocationResult;
  marketId?: string;
  createdAt: string;
  updatedAt: string;
}

let mutationQueue: Promise<void> = Promise.resolve();

function dataFile(): string {
  return path.join(process.cwd(), 'data', 'bundled-matches.json');
}

async function readUnsafe(): Promise<BundledMatch[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(dataFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAtomic(matches: readonly BundledMatch[]): Promise<void> {
  const file = dataFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(matches, null, 2));
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

async function mutate<T>(operation: (matches: BundledMatch[]) => Promise<T> | T): Promise<T> {
  let resolveResult!: (value: T) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  mutationQueue = mutationQueue.then(async () => {
    try { resolveResult(await operation(await readUnsafe())); } catch (error) { rejectResult(error); }
  });
  await mutationQueue;
  return result;
}

export async function getBundledMatches(): Promise<BundledMatch[]> {
  await mutationQueue;
  return readUnsafe();
}

export async function addBundledMatch(input: BundledMatchInput): Promise<BundledMatch> {
  return mutate(async matches => {
    const now = new Date().toISOString();
    const created: BundledMatch = {
      ...input, id: crypto.randomUUID(), kind: 'bundle', preview: allocateBundleBudget(input.legs, input.budgetCents),
      createdAt: now, updatedAt: now,
    };
    matches.push(created);
    await writeAtomic(matches);
    return created;
  });
}

export async function updateBundledMatch(id: string, input: BundledMatchInput): Promise<BundledMatch> {
  return mutate(async matches => {
    const index = matches.findIndex(match => match.id === id);
    if (index < 0) throw new Error('Bundled match not found');
    const updated: BundledMatch = {
      ...input, id, kind: 'bundle', preview: allocateBundleBudget(input.legs, input.budgetCents),
      createdAt: matches[index].createdAt, updatedAt: new Date().toISOString(),
    };
    matches[index] = updated;
    await writeAtomic(matches);
    return updated;
  });
}

export async function deleteBundledMatch(id: string): Promise<boolean> {
  return mutate(async matches => {
    const remaining = matches.filter(match => match.id !== id);
    if (remaining.length === matches.length) return false;
    await writeAtomic(remaining);
    return true;
  });
}
