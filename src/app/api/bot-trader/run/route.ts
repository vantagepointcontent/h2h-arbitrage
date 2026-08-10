import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { getBotSettings, runBotTraderOnScanOutcomes, type BotTradeInput } from '@/lib/bot-trader';
import { getSavedMarketById, getSavedMarkets } from '@/lib/persistence';
import { rankBotCandidates } from '@/lib/bot-candidate-selection';
import { getManualMatches } from '@/lib/manual-matches';
import { refreshSingleMarket, type SingleRefreshResult } from '@/app/api/saved-markets/refresh/refresh-single';
import logger from '@/lib/logger';

function authorized(request: NextRequest): boolean {
  const token = process.env.H2H_API_TOKEN;
  if (!token) return true; // no token configured — open (matches existing convention)
  return request.headers.get('x-h2h-token') === token;
}

/** Typed adapter from the arb row returned by refreshSingleMarket to a minimal
 *  UnifiedOutcome-like shape that runBotTraderOnScanOutcomes can evaluate.
 */
interface RefreshArbRow {
  artist: string;
  roiPct: number;
  expectedProfit: number;
  strategy: string;
  totalStake: number;
  apyPct?: number | null;
  kalshiStake?: number;
  pmStake?: number;
  kalshiTicker?: string | null;
  kalshiYesAsk?: number | null;
  kalshiNoAsk?: number | null;
  kalshiYesDepth?: number | string | null;
  kalshiNoDepth?: number | string | null;
  pmConditionId?: string | null;
  pmBestAsk?: number | null;
  pmNoPrice?: number | null;
  pmYesDepth?: number | null;
  pmNoDepth?: number | null;
}

function toBotTradeInput(
  pairId: string,
  marketTitle: string,
  expiryDate: string | undefined,
  arb: RefreshArbRow,
): BotTradeInput {
  return {
    pairId,
    marketTitle,
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
    kalshiYesDepth: parseDepthValue(arb.kalshiYesDepth),
    kalshiNoDepth: parseDepthValue(arb.kalshiNoDepth),
    pmYesDepth: arb.pmYesDepth ?? 0,
    pmNoDepth: arb.pmNoDepth ?? 0,
    expiryDate,
  };
}

function toBotTradeInputs(
  pairId: string,
  marketTitle: string,
  expiryDate: string | undefined,
  rows: unknown[],
): BotTradeInput[] {
  const arbs: RefreshArbRow[] = [];
  for (const row of rows) {
    const parsed = parseRefreshArbRow(row);
    if (parsed) arbs.push(parsed);
  }
  return arbs
    .filter((arb) => arb.roiPct > 0)
    .map((arb) => toBotTradeInput(pairId, marketTitle, expiryDate, arb));
}

function parseRefreshArbRow(row: unknown): RefreshArbRow | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.artist !== 'string' || typeof r.roiPct !== 'number' || typeof r.expectedProfit !== 'number' || typeof r.strategy !== 'string') {
    return null;
  }
  return {
    artist: r.artist,
    roiPct: r.roiPct,
    expectedProfit: r.expectedProfit,
    strategy: r.strategy,
    totalStake: typeof r.totalStake === 'number' ? r.totalStake : 0,
    apyPct: typeof r.apyPct === 'number' ? r.apyPct : null,
    kalshiStake: typeof r.kalshiStake === 'number' ? r.kalshiStake : undefined,
    pmStake: typeof r.pmStake === 'number' ? r.pmStake : undefined,
    kalshiTicker: typeof r.kalshiTicker === 'string' ? r.kalshiTicker : null,
    kalshiYesAsk: typeof r.kalshiYesAsk === 'number' ? r.kalshiYesAsk : null,
    kalshiNoAsk: typeof r.kalshiNoAsk === 'number' ? r.kalshiNoAsk : null,
    kalshiYesDepth: typeof r.kalshiYesDepth === 'number' || typeof r.kalshiYesDepth === 'string' ? r.kalshiYesDepth : null,
    kalshiNoDepth: typeof r.kalshiNoDepth === 'number' || typeof r.kalshiNoDepth === 'string' ? r.kalshiNoDepth : null,
    pmConditionId: typeof r.pmConditionId === 'string' ? r.pmConditionId : null,
    pmBestAsk: typeof r.pmBestAsk === 'number' ? r.pmBestAsk : null,
    pmNoPrice: typeof r.pmNoPrice === 'number' ? r.pmNoPrice : null,
    pmYesDepth: typeof r.pmYesDepth === 'number' ? r.pmYesDepth : null,
    pmNoDepth: typeof r.pmNoDepth === 'number' ? r.pmNoDepth : null,
  };
}

function parseDepthValue(val: number | string | null | undefined): number {
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

/**
 * POST /api/bot-trader/run
 * FEAT-040: one-off BotTrader evaluation for a saved market pair.
 * Re-fetches the market via refreshSingleMarket, evaluates each matched
 * outcome against bot criteria, and simulates/executes (paper-only unless
 * separately authorized).
 *
 * Body: { pairId: string; marketTitle?: string }
 *
 * Mutations require the shared API token (same scheme as other mutating routes).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!authorized(req)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    let pairId = body?.pairId;
    const marketTitle = body?.marketTitle;

    const settings = await getBotSettings();
    let selectedBy = 'explicit' as string;
    if (pairId == null && body?.ranked === true) {
      const ranked = rankBotCandidates(await getSavedMarkets(), settings.selectionMethod, Date.now(), {
        minRoiPct: settings.minRoiPct,
        minApyPct: settings.minApyPct,
      });
      if (ranked.length === 0) {
        return NextResponse.json({ error: 'No eligible ranked candidate', selectionMethod: settings.selectionMethod }, { status: 404 });
      }
      const requestedLimit = Number(body?.maxCandidates ?? ranked.length);
      const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : ranked.length));
      const requestedOffset = Number(body?.rankedOffset ?? 0);
      const offset = Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0);
      const manualMatches = await getManualMatches();
      const runs = [];
      for (const candidate of ranked.slice(offset, offset + limit)) {
        const market = candidate.market;
        try {
          const result: SingleRefreshResult = await refreshSingleMarket(market, manualMatches);
          const inputs = toBotTradeInputs(market.id, market.eventTitle, result.expiryDate ?? undefined, result.allArbs || []);
          const botResults = await runBotTraderOnScanOutcomes(market.id, market.eventTitle, result.expiryDate ?? undefined, inputs);
          runs.push({
            pairId: market.id,
            marketTitle: market.eventTitle,
            rankedRoiPct: candidate.roiPct,
            rankedApyPct: candidate.apyPct,
            evaluated: inputs.length,
            executed: botResults.filter((item) => item.executed).length,
            results: botResults.map((item) => ({ executed: item.executed, dryRun: item.dryRun, reason: item.reason })),
          });
        } catch (error) {
          // One stale/broken candidate must not prevent the queue from moving
          // from the next-best market to the next.
          runs.push({ pairId: market.id, marketTitle: market.eventTitle, rankedRoiPct: candidate.roiPct, rankedApyPct: candidate.apyPct, evaluated: 0, executed: 0, error: clientSafeError(error) });
        }
      }
      return NextResponse.json({
        selectionMethod: settings.selectionMethod,
        ranked: true,
        candidatesAvailable: ranked.length,
        rankedOffset: offset,
        candidatesProcessed: runs.length,
        executed: runs.reduce((total, run) => total + run.executed, 0),
        runs,
      });
    } else if (typeof pairId !== 'string' || pairId.length === 0) {
      return NextResponse.json({ error: 'Missing or invalid pairId; pass ranked=true to select the top candidate' }, { status: 400 });
    }

    const market = await getSavedMarketById(pairId);
    if (!market) {
      return NextResponse.json({ error: `Market not found: ${pairId}` }, { status: 404 });
    }

    const manualMatches = await getManualMatches();
    const result: SingleRefreshResult = await refreshSingleMarket(market, manualMatches);

    const inputs = toBotTradeInputs(
      market.id,
      marketTitle || market.eventTitle,
      result.expiryDate ?? undefined,
      result.allArbs || [],
    );

    const botResults = await runBotTraderOnScanOutcomes(
      market.id,
      marketTitle || market.eventTitle,
      result.expiryDate ?? undefined,
      inputs,
    );

    const executed = botResults.filter((b) => b.executed).length;
    if (executed > 0) {
      logger.info('[bot-trader/run] executed trades', { pairId, executed });
    }

    return NextResponse.json({
      pairId: market.id,
      marketTitle: market.eventTitle,
      selectionMethod: selectedBy,
      evaluated: inputs.length,
      executed,
      results: botResults.map((b) => ({ executed: b.executed, dryRun: b.dryRun, reason: b.reason })),
    });
  } catch (err) {
    logger.error('[bot-trader/run] error', { error: String(err) });
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
