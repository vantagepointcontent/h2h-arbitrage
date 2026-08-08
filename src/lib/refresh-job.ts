import { promises as fs } from 'fs';
import path from 'path';
import { getSavedMarkets, SavedMarket, updateSavedMarketScanResult } from '@/lib/persistence';
import { getManualMatches } from '@/lib/manual-matches';
import { refreshSingleMarket } from '@/app/api/saved-markets/refresh/refresh-single';
import { runBotTraderOnScanOutcomes, type BotTradeInput } from '@/lib/bot-trader';

function parseDepthString(val: number | string | null | undefined): number {
  if (val == null) return 0;
  if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? val : 0;
  const s = String(val).trim().replace(/^\$/, '');
  if (s === 'Infinity') return 0;
  const m = s.match(/^(\d[\d,]*(?:\.\d+)?)\s*([KMB]?)\s*$/i);
  if (!m) return 0;
  let num = parseFloat(m[1].replace(/,/g, ''));
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') num *= 1000;
  if (suffix === 'M') num *= 1_000_000;
  if (suffix === 'B') num *= 1_000_000_000;
  return Number.isFinite(num) && num > 0 ? num : 0;
}

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

async function runRefreshJob(marketIds?: string[]) {
  const state = await readState();
  if (state.running) return;

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
  const JOB_TIMEOUT_MS = Math.max(60_000, Number(process.env.H2H_REFRESH_TIMEOUT_MS || 300_000)); // 5 min default
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIdx++;
      if (i >= markets.length) return;
      const market = markets[i];
      // BUG-035: skip expired markets entirely
      const expMs = market.expiryDate ? new Date(market.expiryDate).getTime() : 0;
      if (expMs > 0 && expMs <= Date.now()) {
        newState.processed++;
        continue;
      }
      newState.currentMarketId = market.id;
      newState.currentMarketTitle = market.eventTitle;

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
        // FEAT-040: run BotTrader over the scan's matched outcomes.
        // Paper-only unless production is separately authorized.
        try {
          const inputs: BotTradeInput[] = (result.allArbs || [])
            .filter((arb) => arb.roiPct > 0)
            .map((arb: any) => ({
              pairId: market.id,
              marketTitle: market.eventTitle,
              outcome: arb.artist,
              strategy: arb.strategy,
              roiPct: arb.roiPct,
              apyPct: arb.apyPct ?? null,
              expectedProfit: arb.expectedProfit,
              kalshiStake: arb.kalshiStake ?? arb.totalStake / 2,
              pmStake: arb.pmStake ?? arb.totalStake / 2,
              kalshiTicker: arb.kalshiTicker ?? null,
              pmConditionId: arb.pmConditionId ?? null,
              kalshiYesAsk: arb.kalshiYesAsk ?? null,
              kalshiNoAsk: arb.kalshiNoAsk ?? null,
              pmYesAsk: arb.pmBestAsk ?? null,
              pmNoAsk: arb.pmNoPrice ?? null,
              kalshiYesDepth: parseDepthString(arb.kalshiYesDepth),
              kalshiNoDepth: parseDepthString(arb.kalshiNoDepth),
              pmYesDepth: arb.pmYesDepth ?? 0,
              pmNoDepth: arb.pmNoDepth ?? 0,
              expiryDate: result.expiryDate ?? undefined,
            }));
          const botResults = await runBotTraderOnScanOutcomes(market.id, market.eventTitle, result.expiryDate ?? undefined, inputs);
          const executed = botResults.filter((b) => b.executed).length;
          if (executed > 0) {
            console.log(`[refresh-job] BotTrader executed ${executed} trade(s) for ${market.eventTitle}`);
          }
        } catch (e: any) {
          console.warn(`[refresh-job] BotTrader hook failed for ${market.eventTitle}:`, e.message);
        }
        newState.succeeded++;
      } catch (e: any) {
        newState.failed++;
        newState.errors.push({ id: market.id, title: market.eventTitle, error: e.message || 'Unknown error' });
        console.error(`[refresh-job] failed ${market.eventTitle}:`, e.message);
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

  // Race the workers against a hard timeout. If the job exceeds the limit,
  // we stop processing and mark the job as failed so the UI can show a warning
  // instead of spinning forever.
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.error(`[refresh-job] timed out after ${JOB_TIMEOUT_MS}ms, processed ${newState.processed}/${newState.total}`);
      newState.running = false;
      newState.finishedAt = new Date().toISOString();
      newState.errors.push({
        id: '__timeout__',
        title: 'Job timeout',
        error: `Refresh exceeded ${Math.round(JOB_TIMEOUT_MS / 1000)}s limit after processing ${newState.processed}/${newState.total} markets`,
      });
      resolve();
    }, JOB_TIMEOUT_MS);
  });

  await Promise.race([
    Promise.all(Array.from({ length: Math.min(CONCURRENCY, markets.length) }, () => worker())),
    timeoutPromise,
  ]);

  newState.running = false;
  newState.finishedAt = new Date().toISOString();
  newState.currentMarketId = undefined;
  newState.currentMarketTitle = undefined;
  await writeState(newState);
}

export async function getRefreshStatus(): Promise<RefreshJobState> {
  return readState();
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
