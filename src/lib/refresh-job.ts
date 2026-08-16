import { promises as fs } from 'fs';
import path from 'path';
import { getSavedMarkets, reconcileSavedMarketMatchSummary, reserveSavedMarketPublication, updateSavedMarketScanResult } from '@/lib/persistence';
import { getManualMatches } from '@/lib/manual-matches';
import { refreshSingleMarket } from '@/app/api/saved-markets/refresh/refresh-single';
import { persistAndConsumeBotScan } from '@/lib/bot-scan-consumer';

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

function refreshTimeoutMs(): number {
  return Math.max(60_000, Number(process.env.H2H_REFRESH_TIMEOUT_MS || 300_000));
}

function isStaleRunningState(state: RefreshJobState): boolean {
  if (!state.running) return false;
  const startedAt = Date.parse(state.startedAt);
  return !Number.isFinite(startedAt) || Date.now() - startedAt > refreshTimeoutMs();
}

async function writeState(state: RefreshJobState) {
  await fs.writeFile(REFRESH_STATE_FILE, JSON.stringify(state, null, 2));
}

export async function runRefreshJob(marketIds?: string[]) {
  const state = await readState();
  if (state.running && !isStaleRunningState(state)) return;

  const allMarkets = await getSavedMarkets();
  const markets = marketIds && marketIds.length > 0
    ? allMarkets.filter((m) => marketIds.includes(m.id))
    : allMarkets;

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

  // PERF-P2: refresh markets with bounded concurrency (was strictly serial —
  // 470 markets × ~1-4s each ≈ 10+ min). Worker-pool of 4 respects upstream
  // rate limiters (which serialize per-API anyway) while overlapping I/O waits.
  const CONCURRENCY = Math.max(1, Number(process.env.H2H_REFRESH_CONCURRENCY || 4));
  const JOB_TIMEOUT_MS = refreshTimeoutMs(); // 5 min default
  let nextIdx = 0;
  let cancelled = false;

  async function worker(): Promise<void> {
    while (!cancelled) {
      const i = nextIdx++;
      if (i >= markets.length || cancelled) return;
      const market = markets[i];
      // BUG-035: skip expired markets entirely
      const expMs = market.expiryDate ? new Date(market.expiryDate).getTime() : 0;
      if (expMs > 0 && expMs <= Date.now()) {
        newState.processed++;
        continue;
      }
      newState.currentMarketId = market.id;
      newState.currentMarketTitle = market.eventTitle;

      let publicationGeneration: number | null = null;
      try {
        publicationGeneration = await reserveSavedMarketPublication(market.id, 'scan');
        await reconcileSavedMarketMatchSummary(market.id, {
          matchedCount: 0,
          matchStatus: 'refreshing',
          matchError: undefined,
          matchedPairs: undefined,
          scannedAt: new Date().toISOString(),
          publicationGeneration,
        });
        const result = await refreshSingleMarket(market, manualMatches);
        // A timed-out worker may finish its in-flight network request later.
        // Do not persist that stale result or claim another market.
        if (cancelled) {
          await reconcileSavedMarketMatchSummary(market.id, {
            matchedCount: 0,
            matchStatus: 'unavailable',
            matchError: 'Scheduled refresh timed out',
            matchedPairs: undefined,
            scannedAt: new Date().toISOString(),
            publicationGeneration,
          }).catch(() => {});
          return;
        }
        const bestOutcome = result.allArbs.reduce<(typeof result.allArbs)[number] | null>(
          (best, arb) => !best || arb.roiPct > best.roiPct ? arb : best,
          null,
        );
        const outcomeApy = bestOutcome?.outcomeApy;
        const scanResult = {
          bestRoiPct: result.bestRoiPct,
          bestProfit: result.bestProfit,
          strategy: result.strategy,
          outcomeCount: result.matchedCount,
          matchedCount: result.matchedCount,
          matchStatus: result.matchStatus,
          matchError: result.matchError,
          matchedPairs: result.matchedPairs,
          kalshiCount: result.kalshiCount,
          pmCount: result.pmCount,
          positiveArbCount: result.allArbs.filter((arb) => arb.roiPct > 0).length,
          scannedAt: result.scannedAt,
          expiryAt: result.expiryDate ?? null,
          outcomeApy,
          allArbs: result.allArbs,
          expiryDate: result.expiryDate,
          category: market.category,
          publicationGeneration,
        };
        const published = await updateSavedMarketScanResult(market.id, scanResult, result.expiryDate);
        if (!published) throw new Error('Scheduled scan publication was superseded before persistence');
        await persistAndConsumeBotScan(market.id, scanResult, 'scheduled');
        newState.succeeded++;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        if (publicationGeneration != null) {
          await reconcileSavedMarketMatchSummary(market.id, {
            matchedCount: 0,
            matchStatus: 'unavailable',
            matchError: cancelled ? 'Scheduled refresh timed out' : message,
            matchedPairs: undefined,
            scannedAt: new Date().toISOString(),
            publicationGeneration,
          }).catch(() => {});
        }
        if (cancelled) return;
        newState.failed++;
        newState.errors.push({ id: market.id, title: market.eventTitle, error: message });
        console.error(`[refresh-job] failed ${market.eventTitle}:`, message);
      }

      newState.processed++;
      // PERF: debounce state writes — every 5 markets instead of every 1.
      // Reduces disk I/O from ~1,400 writes to ~280 for 470 markets.
      // Final state is always written after the loop completes.
      if (newState.processed % 5 === 0 || newState.processed === newState.total) {
        await writeState(newState);
      }
    }
  }

  // Mark a timed-out job immediately, then retain ownership until all in-flight
  // workers drain. This prevents a second refresh from overlapping late workers.
  const workersPromise = Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, markets.length) }, () => worker()),
  );
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => {
      cancelled = true;
      console.error(`[refresh-job] timed out after ${JOB_TIMEOUT_MS}ms, processed ${newState.processed}/${newState.total}`);
      newState.running = false;
      newState.finishedAt = new Date().toISOString();
      newState.errors.push({
        id: '__timeout__',
        title: 'Job timeout',
        error: `Refresh exceeded ${Math.round(JOB_TIMEOUT_MS / 1000)}s limit after processing ${newState.processed}/${newState.total} markets`,
      });
      resolve('timeout');
    }, JOB_TIMEOUT_MS);
  });

  const outcome = await Promise.race([
    workersPromise.then(() => 'complete' as const),
    timeoutPromise,
  ]);
  if (outcome === 'complete') {
    clearTimeout(timeoutHandle!);
  } else {
    await writeState(newState);
    await workersPromise;
  }

  newState.running = false;
  newState.finishedAt = new Date().toISOString();
  newState.currentMarketId = undefined;
  newState.currentMarketTitle = undefined;
  await writeState(newState);
}

export async function getRefreshStatus(): Promise<RefreshJobState> {
  const state = await readState();
  if (!isStaleRunningState(state)) return state;

  const recovered: RefreshJobState = {
    ...state,
    running: false,
    finishedAt: new Date().toISOString(),
    currentMarketId: undefined,
    currentMarketTitle: undefined,
    errors: [
      ...state.errors,
      {
        id: '__stale__',
        title: 'Interrupted refresh',
        error: 'Recovered stale running state after the refresh process stopped',
      },
    ],
  };
  await writeState(recovered);
  return recovered;
}

export async function startRefreshJob(marketIds?: string[]): Promise<RefreshJobState | null> {
  if (activeJob) {
    const state = await readState();
    return state.running ? state : null;
  }
  activeJob = runRefreshJob(marketIds);
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
