import type { BotPosition } from './bot-positions';
import { getBotPositions } from './bot-positions';
import { getExecutions } from './persistence';
import {
  reconcileSettlementLifecycle,
  type ReconciledSettlementLeg,
  type SettlementExecutionLegEvidence,
  type SettlementResolutionObservation,
} from './bot-settlement';
import { BotSettlementStore } from './bot-settlement-store';
import { normalizeKalshiResolution, normalizePolymarketResolution } from './settlement-resolution';

interface SettlementOrderRecord {
  marketId?: unknown;
  ticker?: unknown;
  conditionId?: unknown;
  outcome?: unknown;
  contracts?: unknown;
}

interface SettlementOrderResult {
  status?: unknown;
  filledContracts?: unknown;
  orderId?: unknown;
}

interface SettlementExecutionResult {
  success?: unknown;
  rollbackExecuted?: unknown;
  kalshiResult?: SettlementOrderResult | null;
  polymarketResult?: SettlementOrderResult | null;
}

export interface SettlementExecutionRecord {
  id: number;
  dryRun: boolean;
  success: boolean;
  kalshiOrder: SettlementOrderRecord | null;
  polymarketOrder: SettlementOrderRecord | null;
  result: SettlementExecutionResult | null;
  botEntryEvidence: unknown;
}

interface EntryEvidenceFill {
  fillId?: unknown;
}

interface EntryEvidenceLeg {
  venue?: unknown;
  marketId?: unknown;
  orderId?: unknown;
  quantityMicrounits?: unknown;
  fills?: EntryEvidenceFill[];
}

function normalizedId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function safePositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function safeNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

interface SettlementCreditEvidence {
  creditState: 'redeemable' | 'credited';
  creditedAt?: string;
  settlementFeeCents: number;
  sourceVersion: string;
}

function exactDollarCents(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const microusd = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (microusd % 10_000n !== 0n) return null;
  const cents = microusd / 10_000n;
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function exactCount(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizeKalshiSettlementCredit(
  payload: unknown,
  leg: SettlementExecutionLegEvidence,
  winningSide: 'yes' | 'no',
): SettlementCreditEvidence | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const settlements = (payload as Record<string, unknown>).settlements;
  if (!Array.isArray(settlements) || !leg.marketId) return null;
  const matches = settlements.filter((value) => value && typeof value === 'object' && !Array.isArray(value)
    && normalizedId((value as Record<string, unknown>).ticker)?.toLowerCase() === leg.marketId!.toLowerCase());
  if (matches.length !== 1) return null;
  const record = matches[0] as Record<string, unknown>;
  if (record.market_result !== winningSide) return null;
  const yesCount = exactCount(record.yes_count_fp);
  const noCount = exactCount(record.no_count_fp);
  const remainingQuantity = leg.remainingQuantity ?? leg.filledQuantity;
  if (remainingQuantity == null || !Number.isSafeInteger(remainingQuantity) || remainingQuantity < 0) return null;
  const expectedWinningCount = leg.side === winningSide ? remainingQuantity : 0;
  const expectedLosingCount = leg.side === winningSide ? 0 : remainingQuantity;
  const winningCount = winningSide === 'yes' ? yesCount : noCount;
  const losingCount = winningSide === 'yes' ? noCount : yesCount;
  const revenue = safeNonNegativeInteger(record.revenue);
  const feeCents = exactDollarCents(record.fee_cost);
  const settledAt = normalizedId(record.settled_time);
  if (winningCount !== expectedWinningCount || losingCount !== expectedLosingCount
    || revenue !== expectedWinningCount * 100 || feeCents == null
    || !settledAt || !Number.isFinite(Date.parse(settledAt))) return null;
  return {
    creditState: 'credited',
    creditedAt: settledAt,
    settlementFeeCents: feeCents,
    sourceVersion: `settlement:${settledAt}:${winningSide}:${String(record.yes_count_fp)}:${String(record.no_count_fp)}:${revenue}:${String(record.fee_cost)}`,
  };
}

export function normalizePolymarketRedemptionCredit(
  payload: unknown,
  leg: SettlementExecutionLegEvidence,
  winningSide: 'yes' | 'no',
): SettlementCreditEvidence | null {
  if (!Array.isArray(payload) || !leg.marketId || !leg.outcomeId) return null;
  const matches = payload.filter((value) => value && typeof value === 'object' && !Array.isArray(value)
    && normalizedId((value as Record<string, unknown>).type) === 'REDEEM'
    && normalizedId((value as Record<string, unknown>).conditionId)?.toLowerCase() === leg.marketId!.toLowerCase()
    && normalizedId((value as Record<string, unknown>).asset)?.toLowerCase() === leg.outcomeId!.toLowerCase());
  if (matches.length !== 1) return null;
  const record = matches[0] as Record<string, unknown>;
  const remainingQuantity = leg.remainingQuantity ?? leg.filledQuantity;
  const expectedPayout = leg.side === winningSide ? remainingQuantity : 0;
  const timestamp = safePositiveInteger(record.timestamp);
  const transactionHash = normalizedId(record.transactionHash);
  if (remainingQuantity == null || !Number.isSafeInteger(remainingQuantity) || remainingQuantity < 0
    || record.size !== remainingQuantity || record.usdcSize !== expectedPayout
    || timestamp == null || !transactionHash) return null;
  const creditedAt = new Date(timestamp * 1000).toISOString();
  return {
    creditState: 'credited',
    creditedAt,
    settlementFeeCents: 0,
    sourceVersion: `redeem:${transactionHash}:${timestamp}:${String(record.size)}:${String(record.usdcSize)}`,
  };
}

export function normalizePolymarketRedeemablePosition(
  payload: unknown,
  leg: SettlementExecutionLegEvidence,
): SettlementCreditEvidence | null {
  if (!Array.isArray(payload) || !leg.marketId || !leg.outcomeId) return null;
  const matches = payload.filter((value) => value && typeof value === 'object' && !Array.isArray(value)
    && normalizedId((value as Record<string, unknown>).conditionId)?.toLowerCase() === leg.marketId!.toLowerCase()
    && normalizedId((value as Record<string, unknown>).asset)?.toLowerCase() === leg.outcomeId!.toLowerCase());
  if (matches.length !== 1) return null;
  const record = matches[0] as Record<string, unknown>;
  const remainingQuantity = leg.remainingQuantity ?? leg.filledQuantity;
  if (remainingQuantity == null || !Number.isSafeInteger(remainingQuantity) || remainingQuantity <= 0
    || record.size !== remainingQuantity || record.redeemable !== true) return null;
  return {
    creditState: 'redeemable',
    settlementFeeCents: 0,
    sourceVersion: `redeemable:${leg.marketId}:${leg.outcomeId}:${remainingQuantity}`,
  };
}

function entryEvidenceLeg(value: unknown, venue: 'kalshi' | 'polymarket'): EntryEvidenceLeg | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const legs = record.legs;
  if (!legs || typeof legs !== 'object' || Array.isArray(legs)) return null;
  const leg = (legs as Record<string, unknown>)[venue];
  if (!leg || typeof leg !== 'object' || Array.isArray(leg)) return null;
  return leg as EntryEvidenceLeg;
}

function exactMarketMatches(order: SettlementOrderRecord | null, expected: string | null, venue: 'kalshi' | 'polymarket'): boolean {
  if (!expected) return false;
  const orderId = normalizedId(venue === 'kalshi'
    ? order?.ticker ?? order?.marketId
    : order?.conditionId ?? order?.marketId);
  return orderId?.toLowerCase() === expected.trim().toLowerCase();
}

function resultExposure(
  result: SettlementOrderResult | null | undefined,
  executionSuccess: boolean,
  rollbackExecuted: boolean,
): { state: SettlementExecutionLegEvidence['exposureState']; filled: number | null; orderId: string | null } {
  const status = normalizedId(result?.status)?.toLowerCase() ?? null;
  const filled = safeNonNegativeInteger(result?.filledContracts);
  const orderId = normalizedId(result?.orderId);
  if (rollbackExecuted) {
    return filled === 0
      ? { state: 'rolled_back', filled: 0, orderId }
      : { state: 'unknown', filled, orderId };
  }
  if (filled === 0 && (status === 'failed' || status === 'rejected' || executionSuccess === false)) {
    return { state: 'failed', filled: 0, orderId };
  }
  if (filled === 0) return { state: 'zero_fill', filled: 0, orderId };
  if (filled != null && (status === 'filled' || status === 'partial')) {
    return { state: status === 'filled' ? 'filled' : 'partial_fill', filled, orderId };
  }
  return { state: 'unknown', filled, orderId };
}

function liveFillIds(evidence: EntryEvidenceLeg | null): string[] {
  if (!Array.isArray(evidence?.fills)) return [];
  const ids = evidence.fills.map((fill) => normalizedId(fill?.fillId)).filter((id): id is string => id != null);
  return ids.length === evidence.fills.length ? ids : [];
}

export function buildSettlementExecutionEvidence(
  position: BotPosition,
  execution: SettlementExecutionRecord | null,
): SettlementExecutionLegEvidence[] {
  const build = (venue: 'kalshi' | 'polymarket'): SettlementExecutionLegEvidence => {
    const order = venue === 'kalshi' ? execution?.kalshiOrder : execution?.polymarketOrder;
    const orderResult = venue === 'kalshi' ? execution?.result?.kalshiResult : execution?.result?.polymarketResult;
    const expectedMarketId = venue === 'kalshi' ? position.kalshiTicker : position.pmConditionId;
    const side = venue === 'kalshi' ? position.kalshiSide : position.pmSide;
    const requestedQuantity = venue === 'kalshi' ? position.sharesKalshi : position.sharesPm;
    const remainingQuantity = venue === 'kalshi'
      ? position.remainingSharesKalshi
      : position.remainingSharesPm;
    const exactOutcomeId = venue === 'kalshi'
      ? position.kalshiTicker ? `${position.kalshiTicker}:${position.kalshiSide.toUpperCase()}` : null
      : position.pmEntryTokenId;
    const mode = position.executionMode;
    const evidence = entryEvidenceLeg(execution?.botEntryEvidence, venue);
    const exposure = resultExposure(orderResult, execution?.success === true, execution?.result?.rollbackExecuted === true);
    const marketMatches = execution?.id === position.executionId
      && execution.dryRun === (mode === 'paper')
      && exactMarketMatches(order ?? null, expectedMarketId, venue)
      && normalizedId(order?.outcome)?.toLowerCase() === side;
    const orderQuantity = safePositiveInteger(order?.contracts);
    const liveEvidenceQuantity = safePositiveInteger(evidence?.quantityMicrounits);
    const liveEvidenceMatches = mode === 'live'
      && normalizedId(evidence?.marketId)?.toLowerCase() === expectedMarketId?.trim().toLowerCase()
      && normalizedId(evidence?.orderId)?.toLowerCase() === exposure.orderId?.toLowerCase()
      && liveEvidenceQuantity === (exposure.filled == null ? null : exposure.filled * 1_000_000);
    const fillIds = mode === 'paper'
      ? exposure.orderId && exposure.filled != null && exposure.filled > 0 ? [`${exposure.orderId}:simulated-fill`] : []
      : liveEvidenceMatches ? liveFillIds(evidence) : [];
    const exact = marketMatches
      && orderQuantity === requestedQuantity
      && exactOutcomeId != null
      && Number.isSafeInteger(remainingQuantity)
      && remainingQuantity >= 0
      && exposure.filled != null
      && remainingQuantity <= exposure.filled
      && (mode === 'paper' || (liveEvidenceMatches && fillIds.length > 0));
    return {
      venue,
      marketId: expectedMarketId,
      outcomeId: exactOutcomeId,
      side,
      requestedQuantity,
      filledQuantity: exposure.filled,
      remainingQuantity,
      orderId: exposure.orderId,
      fillIds,
      exposureState: exact ? exposure.state : 'unknown',
      mode,
    };
  };
  return [build('kalshi'), build('polymarket')];
}

export interface ReconcileBotSettlementsDependencies {
  positions: BotPosition[];
  loadExecution: (executionId: number) => Promise<SettlementExecutionRecord | null>;
  fetchKalshiResolution: (leg: SettlementExecutionLegEvidence) => Promise<SettlementResolutionObservation | null>;
  fetchPmResolution: (leg: SettlementExecutionLegEvidence) => Promise<SettlementResolutionObservation | null>;
  persist: (positionId: number, result: ReturnType<typeof reconcileSettlementLifecycle>) => Promise<boolean>;
  loadPrior?: (positionIds: number[]) => Promise<Map<number, { legs: ReconciledSettlementLeg[] }>>;
  observedAt: string;
  venueTimeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function reconcileBotPositionSettlements(dependencies: ReconcileBotSettlementsDependencies): Promise<{
  scanned: number;
  persisted: number;
  settled: number;
  unresolved: number;
  errors: Array<{ id: number; error: string }>;
}> {
  const prior = dependencies.loadPrior
    ? await dependencies.loadPrior(dependencies.positions.map((position) => position.id))
    : new Map<number, { legs: ReconciledSettlementLeg[] }>();
  let persisted = 0;
  let settled = 0;
  let unresolved = 0;
  const errors: Array<{ id: number; error: string }> = [];

  const reconcileOne = async (position: BotPosition) => {
    try {
      const execution = await dependencies.loadExecution(position.executionId);
      const legs = buildSettlementExecutionEvidence(position, execution);
      const exactEvidence = legs.every((leg) => leg.exposureState !== 'unknown'
        && leg.marketId != null && leg.outcomeId != null && leg.orderId != null);
      const venueTimeoutMs = dependencies.venueTimeoutMs ?? 8_000;
      const resolutions = exactEvidence
        ? (await Promise.all([
            withTimeout(dependencies.fetchKalshiResolution(legs[0]), venueTimeoutMs, 'Kalshi settlement lookup timed out'),
            withTimeout(dependencies.fetchPmResolution(legs[1]), venueTimeoutMs, 'Polymarket settlement lookup timed out'),
          ])).filter((value): value is SettlementResolutionObservation => value != null)
        : [];
      const result = reconcileSettlementLifecycle({
        positionId: position.id,
        executionMode: position.executionMode,
        buyCostCents: position.totalCostCents,
        remainingOpenCostCents: position.remainingOpenCostCents,
        realizedPnlBeforeSettlementCents: position.realizedPnlCents ?? 0,
        legs,
        resolutions,
        priorLegs: prior.get(position.id)?.legs,
        observedAt: dependencies.observedAt,
      });
      if (await dependencies.persist(position.id, result)) persisted += 1;
      if (result.positionState === 'settled') settled += 1;
      if (result.positionState === 'settlement_unresolved') unresolved += 1;
    } catch (error) {
      errors.push({ id: position.id, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const workers = Array.from({ length: Math.min(8, dependencies.positions.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < dependencies.positions.length; index += 8) {
      await reconcileOne(dependencies.positions[index]);
    }
  });
  await Promise.all(workers);
  return { scanned: dependencies.positions.length, persisted, settled, unresolved, errors };
}

async function defaultKalshiResolution(leg: SettlementExecutionLegEvidence): Promise<SettlementResolutionObservation | null> {
  const { fetchKalshiMarket } = await import('./kalshi');
  const market = await fetchKalshiMarket(leg.marketId!);
  if (!market) return null;
  const resolution = normalizeKalshiResolution(market);
  if (!resolution.verified) return null;
  const observedAt = new Date().toISOString();
  let credit: SettlementCreditEvidence | null = null;
  let creditFailureReason: string | null = null;
  if (leg.mode === 'live' && leg.side === resolution.outcome) {
    try {
      const { makeKalshiAuthHeaders } = await import('./kalshi-auth');
      const path = '/trade-api/v2/portfolio/settlements';
      const query = new URLSearchParams({ ticker: leg.marketId!, limit: '100' });
      const response = await fetch(`https://api.elections.kalshi.com${path}?${query}`, {
        headers: makeKalshiAuthHeaders('GET', path),
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        creditFailureReason = `Kalshi settlement credit lookup failed: HTTP ${response.status}`;
      } else {
        credit = normalizeKalshiSettlementCredit(await response.json(), leg, resolution.outcome);
        if (!credit) creditFailureReason = 'Kalshi settlement resolved; exact account credit is unavailable or cannot be allocated to this leg';
      }
    } catch (error) {
      creditFailureReason = `Kalshi settlement credit lookup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return {
    venue: 'kalshi', marketId: leg.marketId!, outcomeId: leg.outcomeId!,
    winningSide: resolution.outcome, resolvedAt: observedAt,
    source: resolution.source,
    sourceVersion: credit?.sourceVersion
      ?? `${String(market.status)}:${resolution.outcome}:${resolution.yesPayoutCents}`,
    ...(credit ? {
      creditState: credit.creditState,
      creditedAt: credit.creditedAt,
      settlementFeeCents: credit.settlementFeeCents,
    } : creditFailureReason ? { creditFailureReason } : {}),
  };
}

async function defaultPmResolution(leg: SettlementExecutionLegEvidence): Promise<SettlementResolutionObservation | null> {
  const { fetchClobMarket } = await import('./polymarket-clob');
  const market = await fetchClobMarket(leg.marketId!);
  if (!market || market.condition_id?.trim().toLowerCase() !== leg.marketId?.trim().toLowerCase()) return null;
  const resolution = normalizePolymarketResolution(market);
  if (!resolution.verified || !Array.isArray(market.tokens)) return null;
  const held = market.tokens.find((token) => token.token_id?.trim().toLowerCase() === leg.outcomeId?.trim().toLowerCase());
  if (!held || held.outcome?.trim().toLowerCase() !== leg.side) return null;
  const observedAt = new Date().toISOString();
  const tokenVersion = market.tokens.map((token) => `${token.token_id}:${token.outcome}:${String(token.winner)}`).sort().join('|');
  let credit: SettlementCreditEvidence | null = null;
  let creditFailureReason: string | null = null;
  if (leg.mode === 'live' && leg.side === resolution.outcome) {
    try {
      const { getPolymarketPositions, getPolymarketWalletAddress } = await import('./polymarket-positions');
      const address = await getPolymarketWalletAddress();
      if (address) {
        const query = new URLSearchParams({
          user: address,
          market: leg.marketId!,
          type: 'REDEEM',
          limit: '500',
        });
        const response = await fetch(`https://data-api.polymarket.com/activity?${query}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
          cache: 'no-store',
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) {
          creditFailureReason = `Polymarket redemption lookup failed: HTTP ${response.status}`;
        } else {
          credit = normalizePolymarketRedemptionCredit(await response.json(), leg, resolution.outcome);
          if (!credit) {
            credit = normalizePolymarketRedeemablePosition(await getPolymarketPositions(), leg);
            if (!credit) creditFailureReason = 'Polymarket resolved; exact token is neither redeemable nor associated with an observed redemption cash flow';
          }
        }
      } else {
        creditFailureReason = 'Polymarket redemption lookup unavailable: wallet identity is not configured';
      }
    } catch (error) {
      creditFailureReason = `Polymarket redemption lookup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return {
    venue: 'polymarket', marketId: leg.marketId!, outcomeId: leg.outcomeId!,
    winningSide: resolution.outcome, resolvedAt: observedAt,
    source: resolution.source,
    sourceVersion: credit?.sourceVersion
      ?? `closed:${String(market.closed)}:active:${String(market.active)}:${tokenVersion}`,
    ...(credit ? {
      creditState: credit.creditState,
      ...(credit.creditedAt ? { creditedAt: credit.creditedAt } : {}),
      settlementFeeCents: credit.settlementFeeCents,
    } : creditFailureReason ? { creditFailureReason } : {}),
  };
}

export async function runBotSettlementReconciler(observedAt = new Date().toISOString()): Promise<{
  scanned: number; persisted: number; settled: number; unresolved: number; errors: Array<{ id: number; error: string }>;
}> {
  const [positions, executions] = await Promise.all([
    getBotPositions({ status: 'all', limit: 1000 }),
    getExecutions(10_000, 'bot'),
  ]);
  const settlementStore = new BotSettlementStore();
  const executionById = new Map(executions.map((execution) => [execution.id, execution as unknown as SettlementExecutionRecord]));
  try {
    const openPositions = positions.filter((position) => position.status === 'open');
    const prior = await settlementStore.getByPositionIds(openPositions.map((position) => position.id));
    const immediate: BotPosition[] = [];
    const venueCandidates: BotPosition[] = [];
    const observedMs = Date.parse(observedAt);
    for (const position of openPositions) {
      const evidence = buildSettlementExecutionEvidence(position, executionById.get(position.executionId) ?? null);
      const exact = evidence.every((leg) => leg.exposureState !== 'unknown'
        && leg.marketId != null && leg.outcomeId != null && leg.orderId != null);
      if (!exact) {
        immediate.push(position);
        continue;
      }
      const expiryMs = Date.parse(position.expiryDate ?? '');
      const priorState = prior.get(position.id)?.positionState;
      if (!Number.isFinite(expiryMs) || expiryMs <= observedMs || (priorState != null && priorState !== 'open')) {
        venueCandidates.push(position);
      }
    }
    venueCandidates.sort((left, right) => {
      const leftAt = prior.get(left.id)?.reconciledAt ?? '';
      const rightAt = prior.get(right.id)?.reconciledAt ?? '';
      return leftAt.localeCompare(rightAt) || left.openedAt.localeCompare(right.openedAt) || left.id - right.id;
    });
    // Bound recurring venue fan-out while rotating unknown-expiry candidates by
    // their oldest persisted reconciliation observation.
    const candidates = [...immediate, ...venueCandidates.slice(0, 64)];
    return await reconcileBotPositionSettlements({
      positions: candidates,
      loadExecution: async (executionId) => executionById.get(executionId) ?? null,
      fetchKalshiResolution: defaultKalshiResolution,
      fetchPmResolution: defaultPmResolution,
      persist: (positionId, result) => settlementStore.persist(positionId, result),
      loadPrior: async (positionIds) => new Map(positionIds.flatMap((id) => {
        const result = prior.get(id);
        return result ? [[id, result]] : [];
      })),
      observedAt,
    });
  } finally {
    settlementStore.close();
  }
}
