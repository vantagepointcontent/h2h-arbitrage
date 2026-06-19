import { promises as fs } from 'fs';
import path from 'path';
import { getSavedMarkets, SavedMarket, updateSavedMarketScanResult } from '@/lib/persistence';
import { getManualMatches } from '@/lib/manual-matches';
import { refreshSingleMarket } from '@/app/api/saved-markets/refresh/refresh-single';

const REFRESH_STATE_FILE = path.join(process.cwd(), 'data', 'refresh-job-state.json');

export interface RefreshJobState {
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentMarketId?: string;
  currentMarketTitle?: string;
  errors: { id: string; title: string; error: string }[];
}

let activeJob: Promise<void> | null = null;

async function readState(): Promise<RefreshJobState> {
  try {
    return JSON.parse(await fs.readFile(REFRESH_STATE_FILE, 'utf-8'));
  } catch {
    return { running: false, startedAt: '', total: 0, processed: 0, succeeded: 0, failed: 0, errors: [] };
  }
}

async function writeState(state: RefreshJobState) {
  await fs.writeFile(REFRESH_STATE_FILE, JSON.stringify(state, null, 2));
}

async function runRefreshJob() {
  const state = await readState();
  if (state.running) return;

  const markets = await getSavedMarkets();
  if (markets.length === 0) {
    await writeState({ running: false, startedAt: new Date().toISOString(), total: 0, processed: 0, succeeded: 0, failed: 0, errors: [] });
    return;
  }

  const manualMatches = await getManualMatches();

  const newState: RefreshJobState = {
    running: true,
    startedAt: new Date().toISOString(),
    total: markets.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
  };
  await writeState(newState);

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    newState.currentMarketId = market.id;
    newState.currentMarketTitle = market.eventTitle;
    await writeState(newState);

    try {
      const result = await refreshSingleMarket(market, manualMatches);
      const scanResult = {
        bestRoiPct: result.bestRoiPct,
        bestProfit: result.bestProfit,
        strategy: result.strategy,
        outcomeCount: result.matchedCount,
        matchedCount: result.matchedCount,
        kalshiCount: result.kalshiCount,
        pmCount: result.pmCount,
        scannedAt: result.scannedAt,
        allArbs: result.allArbs,
      };
      await updateSavedMarketScanResult(market.id, scanResult, result.expiryDate);
      newState.succeeded++;
    } catch (e: any) {
      newState.failed++;
      newState.errors.push({ id: market.id, title: market.eventTitle, error: e.message || 'Unknown error' });
      console.error(`[refresh-job] failed ${market.eventTitle}:`, e.message);
    }

    newState.processed++;
    await writeState(newState);
  }

  newState.running = false;
  newState.finishedAt = new Date().toISOString();
  newState.currentMarketId = undefined;
  newState.currentMarketTitle = undefined;
  await writeState(newState);
}

export async function getRefreshStatus(): Promise<RefreshJobState> {
  return readState();
}

export async function startRefreshJob(): Promise<RefreshJobState | null> {
  if (activeJob) {
    const state = await readState();
    return state.running ? state : null;
  }
  activeJob = runRefreshJob();
  activeJob.finally(() => {
    activeJob = null;
  });
  // Give job a moment to write initial state
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 50));
    const state = await readState();
    if (state.running) return state;
  }
  return null;
}
