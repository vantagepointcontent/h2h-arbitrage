import { promises as fs } from 'fs';
import path from 'path';

export interface PredictionHuntQuotaState {
  status: 'unknown' | 'available' | 'exhausted';
  checkedAt: string | null;
  nextCheckAt: string | null;
  reason: string | null;
}

const STATE_FILE = path.join(process.cwd(), 'data', 'predictionhunt-quota.json');
const MONTHLY_LIMIT_CODE = 'rate_limit.exceeded_month';

export class PredictionHuntQuotaExhaustedError extends Error {
  readonly code = MONTHLY_LIMIT_CODE;
  constructor(public readonly nextCheckAt: string) {
    super(`PredictionHunt monthly quota exhausted; next availability check at ${nextCheckAt}`);
    this.name = 'PredictionHuntQuotaExhaustedError';
  }
}

export function nextUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export function isMonthlyQuotaError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? '');
  return message.includes(MONTHLY_LIMIT_CODE);
}

export function mayCheckQuota(state: PredictionHuntQuotaState, now = new Date()): boolean {
  if (state.status !== 'exhausted' || !state.nextCheckAt) return true;
  const next = Date.parse(state.nextCheckAt);
  return !Number.isFinite(next) || now.getTime() >= next;
}

async function writeState(state: PredictionHuntQuotaState): Promise<void> {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_FILE);
}

export async function getPredictionHuntQuotaState(): Promise<PredictionHuntQuotaState> {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) as PredictionHuntQuotaState;
    if (parsed && ['unknown', 'available', 'exhausted'].includes(parsed.status)) return parsed;
  } catch { /* missing or invalid state starts unknown */ }
  return { status: 'unknown', checkedAt: null, nextCheckAt: null, reason: null };
}

export async function assertPredictionHuntQuotaCheckAllowed(now = new Date()): Promise<void> {
  const state = await getPredictionHuntQuotaState();
  if (!mayCheckQuota(state, now)) {
    throw new PredictionHuntQuotaExhaustedError(state.nextCheckAt!);
  }
  // Claim the single next-day probe before making the request. Concurrent
  // callers remain blocked unless this probe succeeds and marks quota available.
  if (state.status === 'exhausted') {
    await writeState({
      status: 'exhausted',
      checkedAt: now.toISOString(),
      nextCheckAt: nextUtcDay(now).toISOString(),
      reason: MONTHLY_LIMIT_CODE,
    });
  }
}

export async function markPredictionHuntAvailable(now = new Date()): Promise<void> {
  await writeState({
    status: 'available',
    checkedAt: now.toISOString(),
    nextCheckAt: null,
    reason: null,
  });
}

export async function markPredictionHuntMonthlyExhausted(now = new Date()): Promise<PredictionHuntQuotaState> {
  const state: PredictionHuntQuotaState = {
    status: 'exhausted',
    checkedAt: now.toISOString(),
    nextCheckAt: nextUtcDay(now).toISOString(),
    reason: MONTHLY_LIMIT_CODE,
  };
  await writeState(state);
  return state;
}
