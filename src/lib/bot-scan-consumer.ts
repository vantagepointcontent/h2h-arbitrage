import { createClient } from '@libsql/client';
import path from 'path';
import { evaluateBotTrade, getBotExecutionReadiness, getBotSettings, maybeExecuteBotTrade, resolveBotExecutionMode, sendBotOperationalAlert, type BotExecutionResult, type BotSettings, type BotTradeInput } from './bot-trader';
import type { BotPositionExecutionMode } from './bot-positions';
import logger from './logger';
import { auditArbClassification } from './arb-types';
import type { BotLegRelationshipState } from './bot-leg-identity';
import { isExecutableQuoteConsistent, type ExecutableBookQuote } from './executable-book';
import type { PropositionRelationship } from './proposition-identity';

export type BotScanSource = 'scan_api' | 'watcher' | 'scheduled' | 'catch_up';
export type BotScanDecisionState =
  | 'received'
  | 'criteria_rejected'
  | 'revalidation_rejected'
  | 'placement_attempted'
  | 'placed'
  | 'partial_or_unhedged'
  | 'failed'
  | 'disabled'
  | 'stale'
  | 'daily_limit'
  | 'duplicate_replay'
  | 'reset_cleared';

export interface BotScanFees {
  kalshiFee: number;
  pmFee: number;
  kalshiFeeDetails?: string;
  pmFeeDetails?: string;
}

export interface BotScanCandidate {
  candidateIndex?: number;
  outcome: string;
  kalshiMarketQuestion?: string | null;
  pmMarketQuestion?: string | null;
  kalshiOutcomeLabel?: string | null;
  pmOutcomeLabel?: string | null;
  relationshipVerified?: boolean;
  relationshipState?: BotLegRelationshipState;
  relationshipExplanation?: string | null;
  kalshiSide?: 'yes' | 'no';
  pmSide?: 'yes' | 'no';
  strategy: string;
  propositionRelationship?: PropositionRelationship | null;
  roiPct: number;
  apyPct?: number | null;
  expectedProfit: number;
  kalshiStake: number;
  pmStake: number;
  kalshiTicker: string;
  pmConditionId: string;
  pmYesTokenId?: string | null;
  pmNoTokenId?: string | null;
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  pmYesAsk: number | null;
  pmNoAsk: number | null;
  kalshiYesDepth: number;
  kalshiNoDepth: number;
  pmYesDepth: number;
  pmNoDepth: number;
  kalshiYesExecutableQuote?: ExecutableBookQuote;
  kalshiNoExecutableQuote?: ExecutableBookQuote;
  pmYesExecutableQuote?: ExecutableBookQuote;
  pmNoExecutableQuote?: ExecutableBookQuote;
  pmYesMinOrderSize?: number | null;
  pmNoMinOrderSize?: number | null;
  pmYesTickSize?: number | null;
  pmNoTickSize?: number | null;
  executionStatus?: 'executable' | 'non_executable' | 'unavailable';
  executionBlocker?: string | null;
  fees: BotScanFees | null;
  expiryDate?: string | null;
  category?: string;
  stale?: boolean;
}

export interface RejectedBotScanCandidate {
  candidateIndex: number;
  outcome: string;
  strategy: string;
  reasonCode: string;
  reason: string;
}

export interface PersistedBotScan {
  id: number;
  marketId: string;
  marketTitle: string;
  scannedAt: string;
  positiveArbCount: number;
  candidates: BotScanCandidate[];
  rejectedCandidates?: RejectedBotScanCandidate[];
}

export interface BotScanDecision {
  scanId: number;
  idempotencyKey: string;
  source: BotScanSource;
  state: BotScanDecisionState;
  reasonCode: string;
  reason: string;
  receivedAt: string;
  updatedAt: string;
  attempts: number;
  placementCount: number;
  details: unknown;
  leaseOwner?: string | null;
}

export type BotTraderEvaluationStatus =
  | 'pending'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'not_run_disabled'
  | 'not_applicable_no_positive_arb';

export interface BotScanEvaluationEnvelope {
  scanId: number;
  status: BotTraderEvaluationStatus;
  botTraderEvaluationCompleted: boolean;
  reason: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  settingsVersion: string | null;
  candidateCount: number;
  evaluatedCount: number;
  eligibleCount: number;
  placementAttemptCount: number;
  placedCount: number;
  skippedCount: number;
  failureCount: number;
  missingCandidateIndexes: number[];
  failingCandidateIndexes: number[];
}

interface EvaluationCandidateDecision {
  candidateIndex: number;
  state: string;
  reasonCode: string;
  finalResult: string | null;
  executionId: number | null;
  details: unknown;
}

interface EvaluationScanDecision {
  state: string;
  reasonCode: string;
  reason: string;
  receivedAt: string | null;
  updatedAt: string | null;
  attempts: number;
  placementCount: number;
  details: unknown;
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function summarizeBotScanEvaluation(input: {
  scanId: number;
  candidateIndexes: number[];
  scanDecision: EvaluationScanDecision | null;
  candidateDecisions: EvaluationCandidateDecision[];
}): BotScanEvaluationEnvelope {
  const notApplicable = input.scanDecision?.reasonCode === 'no_positive_arb'
    || input.scanDecision?.reasonCode === 'no_opportunities';
  if (notApplicable) {
    return {
      scanId: input.scanId,
      status: 'not_applicable_no_positive_arb',
      botTraderEvaluationCompleted: false,
      reason: 'No Positive Arb — BotTrader not applicable',
      startedAt: input.scanDecision?.receivedAt ?? null,
      completedAt: input.scanDecision?.updatedAt ?? null,
      updatedAt: input.scanDecision?.updatedAt ?? null,
      settingsVersion: null,
      candidateCount: 0,
      evaluatedCount: 0,
      eligibleCount: 0,
      placementAttemptCount: 0,
      placedCount: 0,
      skippedCount: 0,
      failureCount: 0,
      missingCandidateIndexes: [],
      failingCandidateIndexes: [],
    };
  }
  const resetCleared = input.scanDecision?.state === 'reset_cleared'
    && input.scanDecision.reasonCode === 'ops854_reset_cleared';
  const expected = [...new Set(input.candidateIndexes)].sort((a, b) => a - b);
  const decisionsByIndex = new Map(input.candidateDecisions.map((item) => [item.candidateIndex, item]));
  const terminal = expected.flatMap((candidateIndex) => {
    const decision = decisionsByIndex.get(candidateIndex);
    return decision?.finalResult ? [decision] : [];
  });
  const missingCandidateIndexes = expected.filter((candidateIndex) => !decisionsByIndex.get(candidateIndex)?.finalResult);
  const executionDecisions = input.candidateDecisions.filter((item) => recordObject(item.details)?.stage === 'execution');
  const eligibleCount = input.candidateDecisions.filter((item) =>
    item.state === 'eligible' || item.state === 'accepted' || recordObject(item.details)?.stage === 'execution').length;
  const disabled = input.scanDecision?.state === 'disabled';
  const inProgress = input.scanDecision == null
    || input.scanDecision.state === 'received'
    || input.scanDecision.state === 'placement_attempted';
  const partialExposure = input.scanDecision?.state === 'partial_or_unhedged';
  const failedScan = input.scanDecision?.state === 'failed';
  const allTerminal = terminal.length === expected.length;
  const failingCandidateIndexes = terminal
    .filter((item) => item.state === 'failed' || item.finalResult === 'failed'
      || (recordObject(item.details)?.stage === 'execution' && item.finalResult !== 'accepted'
        && input.scanDecision?.state !== 'daily_limit'))
    .map((item) => item.candidateIndex)
    .sort((a, b) => a - b);
  let status: BotTraderEvaluationStatus;
  if (disabled) status = 'not_run_disabled';
  else if (inProgress) status = 'pending';
  else if (partialExposure || (!allTerminal && terminal.length > 0)) status = 'partial';
  else if (failedScan || failingCandidateIndexes.length > 0 || !allTerminal) status = 'failed';
  else status = 'completed';
  const completed = status === 'completed';
  const decisionDetails = recordObject(input.scanDecision?.details);
  const candidateSettingsVersion = input.candidateDecisions
    .map((item) => recordObject(item.details)?.configVersion)
    .find((value): value is string => typeof value === 'string');
  const settingsVersion = typeof decisionDetails?.configVersion === 'string'
    ? decisionDetails.configVersion
    : candidateSettingsVersion ?? null;
  const placedCount = Math.max(
    input.scanDecision?.placementCount ?? 0,
    terminal.filter((item) => item.finalResult === 'accepted').length,
  );
  const placementAttemptCount = Math.max(input.scanDecision?.attempts ?? 0, executionDecisions.length);
  const failureCount = failingCandidateIndexes.length;
  const skippedCount = terminal.filter((item) =>
    !failingCandidateIndexes.includes(item.candidateIndex) && item.finalResult !== 'accepted').length;
  const reason = completed
    ? resetCleared
      ? input.scanDecision?.reason ?? 'Operator reset candidate audits reconciled'
      : 'Every candidate has a terminal auditable BotTrader decision'
    : input.scanDecision?.reason ?? 'BotTrader evaluation has not started';
  return {
    scanId: input.scanId,
    status,
    botTraderEvaluationCompleted: completed,
    reason,
    startedAt: input.scanDecision?.receivedAt ?? null,
    completedAt: inProgress ? null : input.scanDecision?.updatedAt ?? null,
    updatedAt: input.scanDecision?.updatedAt ?? null,
    settingsVersion,
    candidateCount: expected.length,
    evaluatedCount: terminal.length,
    eligibleCount,
    placementAttemptCount,
    placedCount,
    skippedCount,
    failureCount,
    missingCandidateIndexes,
    failingCandidateIndexes,
  };
}

type DecisionUpdate = Pick<BotScanDecision, 'state' | 'reasonCode' | 'reason'> & Partial<Pick<BotScanDecision, 'attempts' | 'placementCount' | 'details'>>;

export interface BotScanConsumerDeps {
  now(): Date;
  getSettings(): Promise<BotSettings>;
  resolveExecutionMode(settings: BotSettings): Promise<BotPositionExecutionMode>;
  reportModeBlock?(scan: PersistedBotScan, settings: BotSettings): Promise<{ reason: string; alertDurable: boolean; alertError?: string }>;
  loadScan(scanId: number): Promise<PersistedBotScan | null>;
  listBacklog(limit: number): Promise<PersistedBotScan[]>;
  acquire(scan: PersistedBotScan, source: BotScanSource): Promise<BotScanDecision | null>;
  transition(scanId: number, leaseOwner: string, update: DecisionUpdate): Promise<BotScanDecision>;
  finish(scanId: number, leaseOwner: string, update: DecisionUpdate): Promise<BotScanDecision>;
  recordReplay(scanId: number, source: BotScanSource): Promise<void>;
  advanceCursor(scanId: number): Promise<void>;
  revalidate(scan: PersistedBotScan): Promise<BotScanCandidate[]>;
  execute(input: BotTradeInput): Promise<BotExecutionResult>;
  reserveOpportunity?(candidate: BotScanCandidate, executionMode: BotPositionExecutionMode): Promise<boolean>;
  releaseOpportunity?(candidate: BotScanCandidate, executionMode: BotPositionExecutionMode): Promise<void>;
  retainOpportunityForExposure?(candidate: BotScanCandidate, executionMode: BotPositionExecutionMode): Promise<void>;
  recordCandidateDecision?(scan: PersistedBotScan, candidateIndex: number, candidate: BotScanCandidate, state: string, reasonCode: string, reason: string, details?: unknown): Promise<void>;
  maxScanAgeMs?: number;
}

export interface BotScanConsumer {
  consume(scanId: number, source?: BotScanSource): Promise<BotScanDecision>;
  processBacklog(limit?: number): Promise<BotScanDecision[]>;
}

const TERMINAL_REPLAY: BotScanDecision = {
  scanId: 0,
  idempotencyKey: '',
  source: 'catch_up',
  state: 'duplicate_replay',
  reasonCode: 'duplicate_replay',
  reason: 'Scan was already claimed or processed; no duplicate placement was attempted',
  receivedAt: '',
  updatedAt: '',
  attempts: 0,
  placementCount: 0,
  details: null,
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validFees(fees: BotScanFees | null): fees is BotScanFees {
  return fees != null && finite(fees.kalshiFee) && fees.kalshiFee >= 0 && finite(fees.pmFee) && fees.pmFee >= 0;
}

function candidateToInput(scan: PersistedBotScan, item: BotScanCandidate, settings: BotSettings, reservationMode?: BotPositionExecutionMode): BotTradeInput {
  const candidateIndex = sourceCandidateIndex(scan, item);
  return {
    pairId: scan.marketId,
    marketTitle: scan.marketTitle,
    outcome: item.outcome,
    kalshiMarketQuestion: item.kalshiMarketQuestion ?? null,
    pmMarketQuestion: item.pmMarketQuestion ?? null,
    kalshiOutcomeLabel: item.kalshiOutcomeLabel ?? null,
    pmOutcomeLabel: item.pmOutcomeLabel ?? null,
    relationshipVerified: item.relationshipVerified === true,
    relationshipState: item.relationshipState,
    relationshipExplanation: item.relationshipExplanation ?? null,
    kalshiSide: item.kalshiSide,
    pmSide: item.pmSide,
    strategy: item.strategy,
    propositionRelationship: item.propositionRelationship ?? null,
    roiPct: item.roiPct,
    apyPct: item.apyPct ?? null,
    expectedProfit: item.expectedProfit,
    kalshiStake: item.kalshiStake,
    pmStake: item.pmStake,
    kalshiTicker: item.kalshiTicker,
    pmConditionId: item.pmConditionId,
    pmYesTokenId: item.pmYesTokenId ?? null,
    pmNoTokenId: item.pmNoTokenId ?? null,
    kalshiYesAsk: item.kalshiYesAsk,
    kalshiNoAsk: item.kalshiNoAsk,
    pmYesAsk: item.pmYesAsk,
    pmNoAsk: item.pmNoAsk,
    kalshiYesDepth: item.kalshiYesDepth,
    kalshiNoDepth: item.kalshiNoDepth,
    pmYesDepth: item.pmYesDepth,
    pmNoDepth: item.pmNoDepth,
    kalshiYesExecutableQuote: item.kalshiYesExecutableQuote,
    kalshiNoExecutableQuote: item.kalshiNoExecutableQuote,
    pmYesExecutableQuote: item.pmYesExecutableQuote,
    pmNoExecutableQuote: item.pmNoExecutableQuote,
    pmYesMinOrderSize: item.pmYesMinOrderSize ?? null,
    pmNoMinOrderSize: item.pmNoMinOrderSize ?? null,
    pmYesTickSize: item.pmYesTickSize ?? null,
    pmNoTickSize: item.pmNoTickSize ?? null,
    expiryDate: item.expiryDate ?? null,
    category: item.category,
    selectionMethod: settings.selectionMethod,
    reservationMode,
    sourceScanId: scan.id,
    sourceOpportunityId: candidateIndex >= 0 ? `scan:${scan.id}:opportunity:${candidateIndex}` : null,
  };
}

function sameProposition(before: BotScanCandidate, current: BotScanCandidate): boolean {
  return before.outcome === current.outcome
    && before.strategy === current.strategy
    && before.kalshiTicker === current.kalshiTicker
    && before.pmConditionId === current.pmConditionId;
}

function sameNamedCandidate(before: BotScanCandidate, current: BotScanCandidate): boolean {
  return before.outcome === current.outcome && before.strategy === current.strategy;
}

function sourceCandidateIndex(scan: PersistedBotScan, candidate: BotScanCandidate): number {
  return candidate.candidateIndex ?? scan.candidates.findIndex((item) => sameProposition(item, candidate));
}

function rejection(
  state: Extract<BotScanDecisionState, 'criteria_rejected' | 'revalidation_rejected' | 'disabled' | 'stale'>,
  reasonCode: string,
  reason: string,
  details: unknown = null,
): DecisionUpdate {
  return { state, reasonCode, reason, placementCount: 0, details };
}

function candidateAuditDetails(scan: PersistedBotScan, candidateIndex: number, candidate: BotScanCandidate, settings: BotSettings, stage: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    scanId: scan.id,
    opportunityId: `scan:${scan.id}:opportunity:${candidateIndex}`,
    configVersion: `bot-settings-v1:${JSON.stringify(settings)}`,
    stage,
    thresholds: settings,
    inputs: {
      roiPct: candidate.roiPct,
      apyPct: candidate.apyPct ?? null,
      expectedProfit: candidate.expectedProfit,
      expiryDate: candidate.expiryDate ?? null,
      kalshiStake: candidate.kalshiStake,
      pmStake: candidate.pmStake,
      exactIds: {
        kalshiTicker: candidate.kalshiTicker,
        pmConditionId: candidate.pmConditionId,
        pmYesTokenId: candidate.pmYesTokenId ?? null,
        pmNoTokenId: candidate.pmNoTokenId ?? null,
      },
      asks: { kalshiYes: candidate.kalshiYesAsk, kalshiNo: candidate.kalshiNoAsk, pmYes: candidate.pmYesAsk, pmNo: candidate.pmNoAsk },
      executableQuotes: {
        kalshiYes: candidate.kalshiYesExecutableQuote ?? null,
        kalshiNo: candidate.kalshiNoExecutableQuote ?? null,
        pmYes: candidate.pmYesExecutableQuote ?? null,
        pmNo: candidate.pmNoExecutableQuote ?? null,
      },
      depthUsd: { kalshiYes: candidate.kalshiYesDepth, kalshiNo: candidate.kalshiNoDepth, pmYes: candidate.pmYesDepth, pmNo: candidate.pmNoDepth },
      fees: candidate.fees,
      venueConstraints: {
        pmYesMinimumOrder: candidate.pmYesMinOrderSize ?? null,
        pmNoMinimumOrder: candidate.pmNoMinOrderSize ?? null,
        pmYesTickSize: candidate.pmYesTickSize ?? null,
        pmNoTickSize: candidate.pmNoTickSize ?? null,
      },
    },
    ...extra,
  };
}

function rejectedCandidatePlaceholder(candidate: RejectedBotScanCandidate): BotScanCandidate {
  return {
    candidateIndex: candidate.candidateIndex,
    outcome: candidate.outcome,
    strategy: candidate.strategy,
    roiPct: 0,
    expectedProfit: 0,
    kalshiStake: 0,
    pmStake: 0,
    kalshiTicker: '',
    pmConditionId: '',
    kalshiYesAsk: null,
    kalshiNoAsk: null,
    pmYesAsk: null,
    pmNoAsk: null,
    kalshiYesDepth: 0,
    kalshiNoDepth: 0,
    pmYesDepth: 0,
    pmNoDepth: 0,
    fees: null,
  };
}

export function createBotScanConsumer(deps: BotScanConsumerDeps): BotScanConsumer {
  const maxScanAgeMs = deps.maxScanAgeMs ?? 5 * 60_000;

  async function consume(scanId: number, source: BotScanSource = 'catch_up'): Promise<BotScanDecision> {
    const scan = await deps.loadScan(scanId);
    if (!scan) {
      return { ...TERMINAL_REPLAY, scanId, idempotencyKey: `scan:${scanId}`, source, reasonCode: 'scan_not_found', reason: `Persisted scan ${scanId} was not found` };
    }

    const claimed = await deps.acquire(scan, source);
    if (!claimed) {
      await deps.recordReplay(scanId, source);
      return { ...TERMINAL_REPLAY, scanId, idempotencyKey: `scan:${scanId}`, source, receivedAt: scan.scannedAt, updatedAt: deps.now().toISOString() };
    }

    let activeSettingsVersion: string | null = null;
    const withSettingsVersion = (details: unknown): unknown => activeSettingsVersion == null
      ? details
      : { ...(recordObject(details) ?? {}), configVersion: activeSettingsVersion };
    const finish = async (update: DecisionUpdate) => {
      const result = await deps.finish(scanId, claimed.leaseOwner ?? '', {
        ...update,
        details: withSettingsVersion(update.details),
      });
      await deps.advanceCursor(scanId);
      return result;
    };

    // Canonical persisted classification is the fan-out gate. Check it before
    // settings, freshness, revalidation, candidate audit writes, reservations,
    // or placement checks so non-positive scans create no BotTrader workload.
    // A previously persisted placement transition remains fail-closed because
    // possible venue exposure must never be reclassified as not applicable.
    if (scan.positiveArbCount <= 0 && claimed.state !== 'placement_attempted') {
      return finish({
        state: 'criteria_rejected',
        reasonCode: 'no_positive_arb',
        reason: 'No Positive Arb — BotTrader not applicable',
        attempts: 0,
        placementCount: 0,
        details: {
          evaluationStatus: 'not_applicable_no_positive_arb',
          canonicalPositiveArbCount: scan.positiveArbCount,
        },
      });
    }

    const recordTerminalScanSkip = async (
      settings: BotSettings,
      reasonCode: string,
      reason: string,
      extra: Record<string, unknown> = {},
      state = 'rejected',
      candidateFilter?: Set<number>,
    ) => {
      for (const [parsedIndex, candidate] of scan.candidates.entries()) {
        const candidateIndex = candidate.candidateIndex ?? parsedIndex;
        if (candidateFilter && !candidateFilter.has(candidateIndex)) continue;
        await deps.recordCandidateDecision?.(
          scan,
          candidateIndex,
          candidate,
          state,
          reasonCode,
          reason,
          candidateAuditDetails(scan, candidateIndex, candidate, settings, 'scan_status', { final: true, ...extra }),
        );
      }
      for (const rejected of scan.rejectedCandidates ?? []) {
        if (candidateFilter && !candidateFilter.has(rejected.candidateIndex)) continue;
        const placeholder = rejectedCandidatePlaceholder(rejected);
        await deps.recordCandidateDecision?.(
          scan,
          rejected.candidateIndex,
          placeholder,
          state,
          reasonCode,
          `${reason}; candidate input was also invalid: ${rejected.reason}`,
          candidateAuditDetails(scan, rejected.candidateIndex, placeholder, settings, 'scan_status', {
            final: true,
            inputReasonCode: rejected.reasonCode,
            ...extra,
          }),
        );
      }
    };

    const settings = await deps.getSettings();
    activeSettingsVersion = `bot-settings-v1:${JSON.stringify(settings)}`;
    if (claimed.state === 'placement_attempted') {
      const executionMode = await deps.resolveExecutionMode(settings);
      const reason = 'The prior worker stopped after placement began; venue outcome and exposure require explicit reconciliation before this scan can be checkpointed';
      const priorDetails = claimed.details && typeof claimed.details === 'object'
        ? claimed.details as Record<string, unknown>
        : null;
      const persistedAttemptedCandidateIndexes = Array.isArray(priorDetails?.attemptedCandidates)
        ? priorDetails.attemptedCandidates.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const value = (item as Record<string, unknown>).candidateIndex;
          return typeof value === 'number' && Number.isSafeInteger(value) ? [value] : [];
        })
        : [];
      // Older placement rows predate attempted-candidate lineage. Treat absent or
      // malformed lineage as all candidates possibly attempted rather than zero.
      const attemptedCandidateIndexes = persistedAttemptedCandidateIndexes.length > 0
        ? new Set(persistedAttemptedCandidateIndexes)
        : undefined;
      await recordTerminalScanSkip(settings, 'interrupted_placement_reconciliation_required', reason, {
        executionMode,
        possibleExposure: true,
        priorDecision: claimed.details,
      }, 'failed', attemptedCandidateIndexes);
      for (const [parsedIndex, candidate] of scan.candidates.entries()) {
        const candidateIndex = candidate.candidateIndex ?? parsedIndex;
        if (attemptedCandidateIndexes && !attemptedCandidateIndexes.has(candidateIndex)) continue;
        await deps.retainOpportunityForExposure?.(candidate, executionMode).catch((error) => {
          logger.error('[bot-scan-consumer] failed to retain reservation for interrupted placement', { error: String(error) });
        });
      }
      // Do not use `finish`: possible venue exposure must keep the cursor behind
      // this scan until an operator reconciles the outcome explicitly.
      return deps.finish(scanId, claimed.leaseOwner ?? '', {
        state: 'partial_or_unhedged',
        reasonCode: 'interrupted_placement_reconciliation_required',
        reason,
        placementCount: claimed.placementCount,
        attempts: claimed.attempts,
        details: { possibleExposure: true, executionMode, priorDecision: claimed.details },
      });
    }
    if (!settings.enabled) {
      const reason = 'BotTrader was disabled when this persisted scan was consumed';
      await recordTerminalScanSkip(settings, 'bot_disabled', reason);
      return finish(rejection('disabled', 'bot_disabled', reason));
    }
    const executionMode = await deps.resolveExecutionMode(settings);
    if (settings.mode === 'production' && executionMode !== 'live') {
      const report = await deps.reportModeBlock?.(scan, settings).catch((error) => ({
        reason: 'Production execution prerequisites are incomplete',
        alertDurable: false,
        alertError: `Alert persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
      const reason = report?.reason ?? 'Production execution prerequisites are incomplete; execution was blocked instead of simulated';
      for (const [parsedIndex, candidate] of scan.candidates.entries()) {
        await deps.recordCandidateDecision?.(
          scan,
          candidate.candidateIndex ?? parsedIndex,
          candidate,
          'rejected',
          'production_execution_blocked',
          reason,
          candidateAuditDetails(scan, candidate.candidateIndex ?? parsedIndex, candidate, settings, 'production_readiness', {
            final: true,
            executionMode,
            alertDurable: report?.alertDurable ?? false,
            alertError: report?.alertError ?? null,
          }),
        );
      }
      for (const rejected of scan.rejectedCandidates ?? []) {
        const placeholder: BotScanCandidate = {
          candidateIndex: rejected.candidateIndex,
          outcome: rejected.outcome,
          strategy: rejected.strategy,
          roiPct: 0,
          expectedProfit: 0,
          kalshiStake: 0,
          pmStake: 0,
          kalshiTicker: '',
          pmConditionId: '',
          kalshiYesAsk: null,
          kalshiNoAsk: null,
          pmYesAsk: null,
          pmNoAsk: null,
          kalshiYesDepth: 0,
          kalshiNoDepth: 0,
          pmYesDepth: 0,
          pmNoDepth: 0,
          fees: null,
        };
        await deps.recordCandidateDecision?.(
          scan,
          rejected.candidateIndex,
          placeholder,
          'rejected',
          'production_execution_blocked',
          `${reason}; candidate input was also invalid: ${rejected.reason}`,
          candidateAuditDetails(scan, rejected.candidateIndex, placeholder, settings, 'production_readiness', {
            final: true,
            inputReasonCode: rejected.reasonCode,
            executionMode,
            alertDurable: report?.alertDurable ?? false,
            alertError: report?.alertError ?? null,
          }),
        );
      }
      return finish({
        state: 'failed',
        reasonCode: 'production_execution_blocked',
        reason: report?.alertDurable === false && report.alertError ? `${reason}; ${report.alertError}` : reason,
        placementCount: 0,
        details: { executionMode, alertDurable: report?.alertDurable ?? false, alertError: report?.alertError ?? null },
      });
    }

    const scannedAtMs = Date.parse(scan.scannedAt);
    const ageMs = deps.now().getTime() - scannedAtMs;
    if (!Number.isFinite(scannedAtMs) || ageMs < 0 || ageMs > maxScanAgeMs) {
      const reason = `Persisted scan is stale or has an invalid timestamp (age ${Number.isFinite(ageMs) ? ageMs : 'unknown'}ms)`;
      await recordTerminalScanSkip(settings, 'scan_stale', reason, { ageMs, maxScanAgeMs });
      return finish(rejection('stale', 'scan_stale', reason, { ageMs, maxScanAgeMs }));
    }

    for (const rejected of scan.rejectedCandidates ?? []) {
      const placeholder: BotScanCandidate = {
        candidateIndex: rejected.candidateIndex,
        outcome: rejected.outcome,
        strategy: rejected.strategy,
        roiPct: 0,
        expectedProfit: 0,
        kalshiStake: 0,
        pmStake: 0,
        kalshiTicker: '',
        pmConditionId: '',
        kalshiYesAsk: null,
        kalshiNoAsk: null,
        pmYesAsk: null,
        pmNoAsk: null,
        kalshiYesDepth: 0,
        kalshiNoDepth: 0,
        pmYesDepth: 0,
        pmNoDepth: 0,
        fees: null,
      };
      await deps.recordCandidateDecision?.(
        scan,
        rejected.candidateIndex,
        placeholder,
        'rejected',
        rejected.reasonCode,
        rejected.reason,
        candidateAuditDetails(scan, rejected.candidateIndex, placeholder, settings, 'input_validation', { final: true }),
      );
    }
    if (scan.candidates.length === 0) {
      return finish(rejection('criteria_rejected', 'malformed_scan', 'Positive-arbitrage scan has no parseable candidate rows'));
    }

    const initiallyEligible: BotScanCandidate[] = [];
    const candidateRejections: Array<{ candidateIndex: number; outcome: string; code: string; reason: string }> = [];
    for (const [parsedIndex, item] of scan.candidates.entries()) {
      const candidateIndex = item.candidateIndex ?? parsedIndex;
      // Paper BotTrader may recover scanner rows that were rejected only because
      // the scanner evaluated the legacy one-share quantity. Its own criteria
      // and execution request re-check matched depth at the effective quantity.
      const unavailable = executionMode !== 'paper'
        && (item.executionStatus === 'non_executable' || item.executionStatus === 'unavailable');
      const evaluation = evaluateBotTrade(candidateToInput(scan, item, settings), settings);
      const eligible = !unavailable && validFees(item.fees) && evaluation.shouldTrade;
      const reasonCode = unavailable ? 'execution_unavailable' : !validFees(item.fees) ? 'fees_unavailable' : eligible ? 'scan_eligible' : 'scan_criteria_rejected';
      const reason = unavailable
        ? item.executionBlocker || `Scanner marked ${item.outcome} ${item.executionStatus}`
        : !validFees(item.fees)
          ? 'Authoritative fee data is unavailable for one or both legs'
          : evaluation.reason;
      await deps.recordCandidateDecision?.(
        scan,
        candidateIndex,
        item,
        eligible ? 'eligible' : 'rejected',
        reasonCode,
        reason,
        candidateAuditDetails(scan, candidateIndex, item, settings, 'scan', { evaluation: evaluation.criteria, final: !eligible }),
      );
      if (eligible) {
        initiallyEligible.push(item);
      } else {
        candidateRejections.push({ candidateIndex, outcome: item.outcome, code: reasonCode, reason });
      }
    }
    if (initiallyEligible.length === 0) {
      // Scanner execution blockers describe its legacy one-share request. Paper
      // mode deliberately re-evaluates the authoritative venue minimum, so its
      // terminal decision must report the BotTrader criteria that actually
      // rejected the candidate rather than the stale scanner blocker.
      const blocked = executionMode === 'paper'
        ? undefined
        : scan.candidates.find((item) => item.executionStatus === 'non_executable' || item.executionStatus === 'unavailable');
      if (blocked) {
        return finish(rejection(
          'criteria_rejected',
          'execution_unavailable',
          blocked.executionBlocker || `Scanner marked ${blocked.outcome} ${blocked.executionStatus}`,
          { outcome: blocked.outcome, executionStatus: blocked.executionStatus, executionBlocker: blocked.executionBlocker },
        ));
      }
      // Build truthful aggregate telemetry when positive opportunities exist
      // but every candidate fails an unchanged gate.
      let aggregateReason: string;
      if (candidateRejections.length === 0) {
        aggregateReason = 'No scan-time candidate satisfies the active BotTrader criteria with complete fee and depth data';
      } else {
        const distinctReasons = [...new Set(candidateRejections.map((r) => r.reason))];
        const registryOnly = distinctReasons.length === 1
          && distinctReasons[0]?.includes('canonical proposition registry');
        if (registryOnly) {
          aggregateReason = `${candidateRejections.length} candidate(s) rejected: exact selected contract pair(s) are absent from the canonical proposition registry`;
        } else {
          aggregateReason = `${candidateRejections.length} candidate(s) evaluated; 0 eligible — ${distinctReasons.join('; ')}`;
        }
      }
      return finish(rejection('criteria_rejected', 'scan_criteria_rejected', aggregateReason, {
        opportunitiesEvaluated: scan.candidates.length,
        eligibleCount: 0,
        candidateRejections: candidateRejections.slice(0, 20),
      }));
    }

    let currentCandidates: BotScanCandidate[];
    try {
      currentCandidates = await deps.revalidate(scan);
    } catch (error) {
      return finish({
        state: 'failed',
        reasonCode: 'revalidation_failed',
        reason: `Executable revalidation failed before placement: ${error instanceof Error ? error.message : String(error)}`,
        placementCount: 0,
        details: { retryable: true },
      });
    }

    const executable: BotScanCandidate[] = [];
    const rejections: Array<{ outcome: string; code: string; reason: string; candidateIndex: number; candidate: BotScanCandidate }> = [];
    for (const original of initiallyEligible) {
      const candidateIndex = sourceCandidateIndex(scan, original);
      const current = currentCandidates.find((item) => sameProposition(original, item));
      if (!current) {
        const changed = currentCandidates.find((item) => sameNamedCandidate(original, item));
        rejections.push({
          outcome: original.outcome,
          code: 'market_identity_changed',
          reason: changed
            ? `Exact market identity changed (${original.kalshiTicker}/${original.pmConditionId} -> ${changed.kalshiTicker}/${changed.pmConditionId})`
            : 'Exact market/outcome identity was not present in the refreshed executable result',
          candidateIndex,
          candidate: changed ?? original,
        });
        continue;
      }
      if (current.stale) {
        rejections.push({ outcome: original.outcome, code: 'current_quote_stale', reason: 'Current executable quote is stale', candidateIndex, candidate: current });
        continue;
      }
      if (!validFees(current.fees)) {
        rejections.push({ outcome: original.outcome, code: 'fees_unavailable', reason: 'Authoritative current fee values are unavailable for one or both legs', candidateIndex, candidate: current });
        continue;
      }
      const evaluation = evaluateBotTrade(candidateToInput(scan, current, settings), settings);
      if (!evaluation.shouldTrade) {
        rejections.push({ outcome: original.outcome, code: 'current_criteria_rejected', reason: evaluation.reason, candidateIndex, candidate: current });
        continue;
      }
      executable.push(current);
    }

    for (const rejected of rejections) {
      await deps.recordCandidateDecision?.(
        scan,
        rejected.candidateIndex,
        rejected.candidate,
        'rejected',
        rejected.code,
        rejected.reason,
        candidateAuditDetails(scan, rejected.candidateIndex, rejected.candidate, settings, 'revalidation', { final: true }),
      );
    }

    if (executable.length === 0) {
      const primary = rejections[0] ?? { code: 'current_criteria_rejected', reason: 'No refreshed candidate remained executable', outcome: '', candidateIndex: -1, candidate: scan.candidates[0] };
      return finish(rejection('revalidation_rejected', primary.code, primary.reason, { rejections }));
    }

    const reserved: BotScanCandidate[] = [];
    for (const item of executable) {
      if (deps.reserveOpportunity && !(await deps.reserveOpportunity(item, executionMode))) {
        const candidateIndex = sourceCandidateIndex(scan, item);
        const reason = 'Exact economic legs are already reserved or have an open BotTrader position';
        rejections.push({ outcome: item.outcome, code: 'opportunity_already_claimed', reason, candidateIndex, candidate: item });
        await deps.recordCandidateDecision?.(scan, candidateIndex, item, 'rejected', 'opportunity_already_claimed', reason,
          candidateAuditDetails(scan, candidateIndex, item, settings, 'reservation', { final: true, executionMode }));
        continue;
      }
      reserved.push(item);
    }
    if (reserved.length === 0) {
      return finish(rejection('criteria_rejected', 'opportunity_already_claimed', 'Every executable opportunity was already claimed by another scan', { rejections }));
    }

    await deps.transition(scanId, claimed.leaseOwner ?? '', {
      state: 'placement_attempted',
      reasonCode: 'placement_attempted',
      reason: `Attempting ${reserved.length} revalidated candidate placement(s)`,
      attempts: claimed.attempts + reserved.length,
      details: withSettingsVersion({
        rejections,
        attemptedCandidates: reserved.map((candidate) => ({
          candidateIndex: sourceCandidateIndex(scan, candidate),
          kalshiTicker: candidate.kalshiTicker,
          pmConditionId: candidate.pmConditionId,
          outcome: candidate.outcome,
        })),
      }),
    });

    const results: Array<{ outcome: string; result?: BotExecutionResult; error?: string }> = [];
    const releaseRemaining = async (startIndex: number) => {
      for (const pending of reserved.slice(startIndex)) {
        await deps.releaseOpportunity?.(pending, executionMode).catch((error) => {
          logger.warn('[bot-scan-consumer] failed to release unattempted opportunity reservation', { error: String(error) });
        });
      }
    };
    for (let index = 0; index < reserved.length; index++) {
      const item = reserved[index];
      try {
        const result = await deps.execute(candidateToInput(scan, item, settings, executionMode));
        results.push({ outcome: item.outcome, result });
        await deps.recordCandidateDecision?.(
          scan,
          sourceCandidateIndex(scan, item),
          item,
          result.executed ? 'accepted' : 'rejected',
          result.executed ? 'execution_completed' : 'execution_rejected',
          result.reason,
          candidateAuditDetails(scan, sourceCandidateIndex(scan, item), item, settings, 'execution', {
            final: true,
            executionId: result.executionId ?? null,
            executionMode,
            positionPersisted: result.positionPersisted ?? null,
            unhedged: result.executionResult?.unhedged ?? null,
          }),
        );
        if (result.executionResult?.unhedged === true
          || result.exposureState === 'pending_reconciliation'
          || (result.executed && result.positionPersisted === false)) {
          await deps.retainOpportunityForExposure?.(item, executionMode).catch((error) => {
            logger.error('[bot-scan-consumer] failed to retain reservation for unhedged exposure', { error: String(error) });
          });
          await releaseRemaining(index + 1);
          break;
        } else if (!result.executed) {
          await deps.releaseOpportunity?.(item, executionMode).catch((error) => {
            logger.warn('[bot-scan-consumer] failed to release rejected opportunity reservation', { error: String(error) });
          });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results.push({ outcome: item.outcome, error: reason });
        await deps.recordCandidateDecision?.(
          scan,
          sourceCandidateIndex(scan, item),
          item,
          'failed',
          'execution_outcome_unknown',
          reason,
          candidateAuditDetails(scan, sourceCandidateIndex(scan, item), item, settings, 'execution', { final: true, executionMode, possibleExposure: true }),
        ).catch((auditError) => logger.error('[bot-scan-consumer] failed to persist final opportunity audit', { error: String(auditError) }));
        // executeArb can throw after one venue accepted an order. Preserve this
        // reservation as possible exposure and stop all further placements.
        await deps.retainOpportunityForExposure?.(item, executionMode).catch((retainError) => {
          logger.error('[bot-scan-consumer] failed to retain reservation after unknown execution outcome', { error: String(retainError) });
        });
        await releaseRemaining(index + 1);
        break;
      }
    }

    const unhedged = results.find((item) => item.result?.executionResult?.unhedged === true);
    const pendingReconciliation = results.find((item) => item.result?.exposureState === 'pending_reconciliation');
    const untracked = results.find((item) => item.result?.executed === true && item.result.positionPersisted === false);
    const unknownExposure = results.find((item) => item.error);
    const placed = results.filter((item) => item.result?.executed === true);
    const dailyLimit = results.find((item) => /daily .*limit/i.test(item.result?.reason ?? ''));
    const failures = results.filter((item) => item.error || (!item.result?.executed && !/daily .*limit/i.test(item.result?.reason ?? '')));
    const dryRun = results.every((item) => item.result?.dryRun !== false);
    const details = { dryRun, results, rejections };

    if (unhedged) {
      return finish({ state: 'partial_or_unhedged', reasonCode: 'partial_or_unhedged', reason: unhedged.result?.reason ?? 'Placement left partial or unhedged exposure', placementCount: placed.length, attempts: claimed.attempts + reserved.length, details });
    }
    if (pendingReconciliation) {
      return finish({ state: 'partial_or_unhedged', reasonCode: 'fill_reconciliation_pending', reason: pendingReconciliation.result?.reason ?? 'Live order acknowledgement is pending authoritative fill reconciliation', placementCount: placed.length, attempts: claimed.attempts + results.length, details });
    }
    if (untracked) {
      return finish({ state: 'partial_or_unhedged', reasonCode: 'position_persistence_failed', reason: untracked.result?.persistenceError ?? 'Executed exposure was not durably recorded as a position', placementCount: placed.length, attempts: claimed.attempts + results.length, details });
    }
    if (unknownExposure) {
      return finish({ state: 'partial_or_unhedged', reasonCode: 'execution_outcome_unknown', reason: `Execution outcome is unknown and may include venue exposure: ${unknownExposure.error}`, placementCount: placed.length, attempts: claimed.attempts + results.length, details });
    }
    if (placed.length > 0) {
      return finish({ state: 'placed', reasonCode: dryRun ? 'paper_placed' : 'production_placed', reason: `${placed.length} revalidated ${dryRun ? 'paper ' : ''}placement(s) completed`, placementCount: placed.length, attempts: claimed.attempts + reserved.length, details });
    }
    if (dailyLimit) {
      return finish({ state: 'daily_limit', reasonCode: 'daily_limit', reason: dailyLimit.result?.reason ?? 'Daily BotTrader limit reached', placementCount: 0, attempts: claimed.attempts + reserved.length, details });
    }
    const firstFailure = failures[0];
    return finish({ state: 'failed', reasonCode: 'placement_failed', reason: firstFailure?.error ?? firstFailure?.result?.reason ?? 'All placement attempts failed', placementCount: 0, attempts: claimed.attempts + reserved.length, details });
  }

  async function processBacklog(limit = 100): Promise<BotScanDecision[]> {
    const scans = await deps.listBacklog(Math.min(1000, Math.max(1, limit)));
    const results: BotScanDecision[] = [];
    for (const item of scans) results.push(await consume(item.id, 'catch_up'));
    return results;
  }

  return { consume, processBacklog };
}

const DB_PATH = path.join(process.cwd(), 'data', 'edgefinder.db');
let schemaReady = false;

async function dbClient() {
  const db = createClient({ url: `file:${DB_PATH}` });
  // Finish connection setup before callers issue queries. A fire-and-forget
  // PRAGMA raced the first BotTrader write and caused libsql commits to fail
  // with "SQL statements in progress" during concurrent scan publication.
  await db.execute('PRAGMA busy_timeout = 5000');
  return db;
}

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const db = await dbClient();
  try {
    await db.batch([
      `CREATE TABLE IF NOT EXISTS bot_scan_decisions (
        scan_id INTEGER PRIMARY KEY REFERENCES scan_results(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        received_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        placement_count INTEGER NOT NULL DEFAULT 0,
        details TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS bot_scan_decision_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        details TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS bot_opportunity_decisions (
        scan_id INTEGER NOT NULL,
        candidate_index INTEGER NOT NULL,
        market_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        strategy TEXT NOT NULL,
        state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        roi_pct REAL,
        apy_pct REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        details TEXT,
        opportunity_id TEXT,
        threshold_config_version TEXT,
        final_result TEXT,
        execution_id INTEGER,
        PRIMARY KEY (scan_id, candidate_index)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_bot_scan_decisions_state ON bot_scan_decisions(state, scan_id)`,
      `CREATE INDEX IF NOT EXISTS idx_bot_scan_events_scan ON bot_scan_decision_events(scan_id, id)`,
      `CREATE INDEX IF NOT EXISTS idx_bot_opportunity_decisions_scan ON bot_opportunity_decisions(scan_id, candidate_index)`,
      `CREATE TABLE IF NOT EXISTS bot_scan_cursor (consumer TEXT PRIMARY KEY, last_scan_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS bot_scan_evaluations (
        scan_id INTEGER PRIMARY KEY REFERENCES scan_results(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT,
        settings_version TEXT,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        evaluated_count INTEGER NOT NULL DEFAULT 0,
        eligible_count INTEGER NOT NULL DEFAULT 0,
        placement_attempt_count INTEGER NOT NULL DEFAULT 0,
        placed_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        missing_candidate_indexes TEXT NOT NULL DEFAULT '[]',
        failing_candidate_indexes TEXT NOT NULL DEFAULT '[]'
      )`,
      `CREATE TABLE IF NOT EXISTS bot_consumer_schema_migrations (
        name TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      )`,
    ], 'write');
    for (const migration of [
      'ALTER TABLE bot_opportunity_decisions ADD COLUMN threshold_config_version TEXT',
      'ALTER TABLE bot_opportunity_decisions ADD COLUMN final_result TEXT',
      'ALTER TABLE bot_opportunity_decisions ADD COLUMN execution_id INTEGER',
      'ALTER TABLE bot_opportunity_decisions ADD COLUMN opportunity_id TEXT',
    ]) {
      try { await db.execute(migration); } catch { /* already migrated */ }
    }
    await db.execute(`UPDATE bot_opportunity_decisions
      SET state='legacy_incomplete', reason_code='legacy_final_result_missing',
          reason='Historical decision lacked a terminal result and was reconciled without replaying execution',
          final_result='legacy_incomplete', updated_at=COALESCE(updated_at, created_at)
      WHERE final_result IS NULL`);
    // OPS-854 deliberately tombstoned the pre-reset BotTrader population while
    // preserving immutable Logs scans. Reconcile those tombstones as terminal
    // audited skips instead of showing every historical Positive Arb as a
    // failed/incomplete consumer gap.
    const scanResultsTable = await db.execute(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_results'",
    );
    const resetReconciliation = await db.execute(
      "SELECT 1 FROM bot_consumer_schema_migrations WHERE name='bug181-reset-candidate-reconciliation-v2'",
    );
    if (scanResultsTable.rows.length > 0 && resetReconciliation.rows.length === 0) {
      await db.execute(`INSERT OR IGNORE INTO bot_opportunity_decisions
      (scan_id,candidate_index,market_id,outcome,strategy,state,reason_code,reason,
       roi_pct,apy_pct,created_at,updated_at,details,opportunity_id,
       threshold_config_version,final_result,execution_id)
      SELECT s.id,CAST(candidate.key AS INTEGER),s.market_id,
        CASE WHEN candidate.type='object' AND json_type(candidate.value,'$.artist')='text'
          AND json_type(candidate.value,'$.strategy')='text' THEN json_extract(candidate.value,'$.artist') ELSE 'unknown' END,
        CASE WHEN candidate.type='object' AND json_type(candidate.value,'$.artist')='text'
          AND json_type(candidate.value,'$.strategy')='text' THEN json_extract(candidate.value,'$.strategy') ELSE 'unknown' END,
        CASE WHEN candidate.type='object'
          AND json_type(candidate.value,'$.artist')='text' AND length(trim(json_extract(candidate.value,'$.artist')))>0
          AND json_type(candidate.value,'$.strategy')='text' AND length(trim(json_extract(candidate.value,'$.strategy')))>0
          AND json_type(candidate.value,'$.roiPct') IN ('integer','real')
          AND json_type(candidate.value,'$.expectedProfit') IN ('integer','real')
          AND json_type(candidate.value,'$.kalshiTicker')='text' AND length(trim(json_extract(candidate.value,'$.kalshiTicker')))>0
          AND json_type(candidate.value,'$.pmConditionId')='text' AND length(trim(json_extract(candidate.value,'$.pmConditionId')))>0
          THEN 'skipped' ELSE 'failed' END,
        CASE WHEN candidate.type='object'
          AND json_type(candidate.value,'$.artist')='text' AND length(trim(json_extract(candidate.value,'$.artist')))>0
          AND json_type(candidate.value,'$.strategy')='text' AND length(trim(json_extract(candidate.value,'$.strategy')))>0
          AND json_type(candidate.value,'$.roiPct') IN ('integer','real')
          AND json_type(candidate.value,'$.expectedProfit') IN ('integer','real')
          AND json_type(candidate.value,'$.kalshiTicker')='text' AND length(trim(json_extract(candidate.value,'$.kalshiTicker')))>0
          AND json_type(candidate.value,'$.pmConditionId')='text' AND length(trim(json_extract(candidate.value,'$.pmConditionId')))>0
          THEN 'ops854_reset_cleared' ELSE 'reset_candidate_payload_unavailable' END,
        d.reason || CASE WHEN candidate.type='object'
          AND json_type(candidate.value,'$.artist')='text' AND length(trim(json_extract(candidate.value,'$.artist')))>0
          AND json_type(candidate.value,'$.strategy')='text' AND length(trim(json_extract(candidate.value,'$.strategy')))>0
          AND json_type(candidate.value,'$.roiPct') IN ('integer','real')
          AND json_type(candidate.value,'$.expectedProfit') IN ('integer','real')
          AND json_type(candidate.value,'$.kalshiTicker')='text' AND length(trim(json_extract(candidate.value,'$.kalshiTicker')))>0
          AND json_type(candidate.value,'$.pmConditionId')='text' AND length(trim(json_extract(candidate.value,'$.pmConditionId')))>0 THEN ''
          ELSE ' Candidate payload is malformed, so exact candidate fields are unavailable.' END,
        CASE WHEN candidate.type='object' THEN json_extract(candidate.value,'$.roiPct') ELSE NULL END,
        CASE WHEN candidate.type='object' THEN json_extract(candidate.value,'$.apyPct') ELSE NULL END,
        d.updated_at,d.updated_at,
        json_object('schemaVersion',1,'stage','operator_reset','final',1,
          'resetReasonCode',d.reason_code,'payloadUnavailable',CASE WHEN candidate.type='object'
            AND json_type(candidate.value,'$.artist')='text' AND length(trim(json_extract(candidate.value,'$.artist')))>0
            AND json_type(candidate.value,'$.strategy')='text' AND length(trim(json_extract(candidate.value,'$.strategy')))>0
            AND json_type(candidate.value,'$.roiPct') IN ('integer','real')
            AND json_type(candidate.value,'$.expectedProfit') IN ('integer','real')
            AND json_type(candidate.value,'$.kalshiTicker')='text' AND length(trim(json_extract(candidate.value,'$.kalshiTicker')))>0
            AND json_type(candidate.value,'$.pmConditionId')='text' AND length(trim(json_extract(candidate.value,'$.pmConditionId')))>0
            THEN 0 ELSE 1 END),
        'scan:' || s.id || ':opportunity:' || candidate.key,
        NULL,'reset_cleared',NULL
      FROM scan_results s
      JOIN bot_scan_decisions d ON d.scan_id=s.id
      JOIN json_each(CASE WHEN json_valid(s.raw_result)
        AND json_type(s.raw_result,'$.allArbs')='array' THEN s.raw_result
        ELSE '{"allArbs":[]}' END,'$.allArbs') candidate
      WHERE d.state='reset_cleared' AND d.reason_code='ops854_reset_cleared'
        AND s.scan_status='completed' AND s.positive_arb_count>0
        AND json_valid(s.raw_result) AND json_type(s.raw_result,'$.allArbs')='array'`);
      await db.execute(`WITH RECURSIVE reset_missing
      (scan_id,market_id,reason,reason_code,updated_at,candidate_index,candidate_count) AS (
        SELECT s.id,s.market_id,d.reason,d.reason_code,d.updated_at,0,s.positive_arb_count
        FROM scan_results s JOIN bot_scan_decisions d ON d.scan_id=s.id
        WHERE d.state='reset_cleared' AND d.reason_code='ops854_reset_cleared'
          AND s.scan_status='completed' AND s.positive_arb_count>0
          AND CASE WHEN json_valid(s.raw_result)
            THEN COALESCE(json_type(s.raw_result,'$.allArbs'),'missing') ELSE 'invalid' END<>'array'
        UNION ALL
        SELECT scan_id,market_id,reason,reason_code,updated_at,candidate_index+1,candidate_count
        FROM reset_missing WHERE candidate_index+1<candidate_count
      )
      INSERT OR IGNORE INTO bot_opportunity_decisions
        (scan_id,candidate_index,market_id,outcome,strategy,state,reason_code,reason,
         roi_pct,apy_pct,created_at,updated_at,details,opportunity_id,
         threshold_config_version,final_result,execution_id)
      SELECT scan_id,candidate_index,market_id,'unknown','unknown','failed',
        'reset_candidate_payload_unavailable',
        reason || ' Candidate payload is malformed, so exact candidate fields are unavailable.',
        NULL,NULL,updated_at,updated_at,
        json_object('schemaVersion',1,'stage','operator_reset','final',1,
          'resetReasonCode',reason_code,'payloadUnavailable',1),
        'scan:' || scan_id || ':opportunity:' || candidate_index,
        NULL,'reset_cleared',NULL
      FROM reset_missing`);
      // Reclassify rows written by earlier BUG-181 builds too. INSERT OR IGNORE
      // cannot repair an existing reset tombstone that treated any JSON object
      // (including `{}`) as an auditable candidate.
      await db.execute(`WITH reset_candidates AS (
        SELECT o.scan_id,o.candidate_index,d.reason,d.reason_code,d.updated_at,candidate.value,
          CASE WHEN candidate.type='object'
            AND json_type(candidate.value,'$.artist')='text' AND length(trim(json_extract(candidate.value,'$.artist')))>0
            AND json_type(candidate.value,'$.strategy')='text' AND length(trim(json_extract(candidate.value,'$.strategy')))>0
            AND json_type(candidate.value,'$.roiPct') IN ('integer','real')
            AND json_type(candidate.value,'$.expectedProfit') IN ('integer','real')
            AND json_type(candidate.value,'$.kalshiTicker')='text' AND length(trim(json_extract(candidate.value,'$.kalshiTicker')))>0
            AND json_type(candidate.value,'$.pmConditionId')='text' AND length(trim(json_extract(candidate.value,'$.pmConditionId')))>0
            THEN 1 ELSE 0 END AS audit_valid
        FROM bot_opportunity_decisions o
        JOIN scan_results s ON s.id=o.scan_id
        JOIN bot_scan_decisions d ON d.scan_id=o.scan_id
        JOIN json_each(CASE WHEN json_valid(s.raw_result)
          AND json_type(s.raw_result,'$.allArbs')='array' THEN s.raw_result
          ELSE '{"allArbs":[]}' END,'$.allArbs') candidate
          ON CAST(candidate.key AS INTEGER)=o.candidate_index
        WHERE d.state='reset_cleared' AND d.reason_code='ops854_reset_cleared'
          AND o.final_result='reset_cleared'
      ), invalid_reset_candidates AS (
        SELECT * FROM reset_candidates WHERE audit_valid=0
      )
      UPDATE bot_opportunity_decisions SET
        outcome='unknown', strategy='unknown', state='failed',
        reason_code='reset_candidate_payload_unavailable',
        reason=(SELECT reason || ' Candidate payload is malformed, so exact candidate fields are unavailable.'
          FROM invalid_reset_candidates r WHERE r.scan_id=bot_opportunity_decisions.scan_id
            AND r.candidate_index=bot_opportunity_decisions.candidate_index),
        details=(SELECT json_object('schemaVersion',1,'stage','operator_reset','final',1,
          'resetReasonCode',reason_code,'payloadUnavailable',1)
          FROM invalid_reset_candidates r WHERE r.scan_id=bot_opportunity_decisions.scan_id
            AND r.candidate_index=bot_opportunity_decisions.candidate_index),
        updated_at=(SELECT updated_at FROM invalid_reset_candidates r WHERE r.scan_id=bot_opportunity_decisions.scan_id
          AND r.candidate_index=bot_opportunity_decisions.candidate_index)
      WHERE EXISTS (SELECT 1 FROM invalid_reset_candidates r WHERE r.scan_id=bot_opportunity_decisions.scan_id
        AND r.candidate_index=bot_opportunity_decisions.candidate_index)`);
      await db.execute(`UPDATE bot_scan_evaluations SET
      status=CASE WHEN EXISTS (SELECT 1 FROM bot_opportunity_decisions o
        WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed'))
        THEN 'failed' ELSE 'completed' END,
      completed=CASE WHEN EXISTS (SELECT 1 FROM bot_opportunity_decisions o
        WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed'))
        THEN 0 ELSE 1 END,
      reason=(SELECT d.reason FROM bot_scan_decisions d WHERE d.scan_id=bot_scan_evaluations.scan_id),
      started_at=(SELECT d.received_at FROM bot_scan_decisions d WHERE d.scan_id=bot_scan_evaluations.scan_id),
      completed_at=(SELECT d.updated_at FROM bot_scan_decisions d WHERE d.scan_id=bot_scan_evaluations.scan_id),
      updated_at=(SELECT d.updated_at FROM bot_scan_decisions d WHERE d.scan_id=bot_scan_evaluations.scan_id),
      settings_version=NULL,
      candidate_count=(SELECT CASE WHEN json_valid(s.raw_result)
        AND json_type(s.raw_result,'$.allArbs')='array'
        THEN COALESCE(json_array_length(json_extract(s.raw_result,'$.allArbs')),s.positive_arb_count)
        ELSE s.positive_arb_count END FROM scan_results s WHERE s.id=bot_scan_evaluations.scan_id),
      evaluated_count=(SELECT COUNT(*) FROM bot_opportunity_decisions o
        WHERE o.scan_id=bot_scan_evaluations.scan_id AND o.final_result IS NOT NULL),
      eligible_count=0, placement_attempt_count=0, placed_count=0,
      skipped_count=(SELECT COUNT(*) FROM bot_opportunity_decisions o
        WHERE o.scan_id=bot_scan_evaluations.scan_id AND o.final_result IS NOT NULL
          AND o.state<>'failed' AND o.final_result NOT IN ('failed','accepted')),
      failure_count=(SELECT COUNT(*) FROM bot_opportunity_decisions o
        WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed')),
      missing_candidate_indexes='[]',
      failing_candidate_indexes=COALESCE((SELECT json_group_array(candidate_index) FROM
        (SELECT candidate_index FROM bot_opportunity_decisions o
          WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed')
          ORDER BY candidate_index)), '[]')
      WHERE scan_id IN (SELECT scan_id FROM bot_scan_decisions
        WHERE state='reset_cleared' AND reason_code='ops854_reset_cleared')
        AND (reason IS NOT (SELECT d.reason FROM bot_scan_decisions d
            WHERE d.scan_id=bot_scan_evaluations.scan_id)
          OR started_at IS NOT (SELECT d.received_at FROM bot_scan_decisions d
            WHERE d.scan_id=bot_scan_evaluations.scan_id)
          OR completed_at IS NOT (SELECT d.updated_at FROM bot_scan_decisions d
            WHERE d.scan_id=bot_scan_evaluations.scan_id)
          OR updated_at IS NOT (SELECT d.updated_at FROM bot_scan_decisions d
            WHERE d.scan_id=bot_scan_evaluations.scan_id)
          OR settings_version IS NOT NULL
          OR candidate_count<>(SELECT CASE WHEN json_valid(s.raw_result)
            AND json_type(s.raw_result,'$.allArbs')='array'
            THEN COALESCE(json_array_length(json_extract(s.raw_result,'$.allArbs')),s.positive_arb_count)
            ELSE s.positive_arb_count END FROM scan_results s WHERE s.id=bot_scan_evaluations.scan_id)
          OR eligible_count<>0 OR placement_attempt_count<>0 OR placed_count<>0
          OR missing_candidate_indexes<>'[]'
          OR status<>CASE WHEN EXISTS (SELECT 1 FROM bot_opportunity_decisions o
            WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed'))
            THEN 'failed' ELSE 'completed' END
          OR completed<>CASE WHEN EXISTS (SELECT 1 FROM bot_opportunity_decisions o
            WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed'))
            THEN 0 ELSE 1 END
          OR evaluated_count<>(SELECT COUNT(*) FROM bot_opportunity_decisions o
            WHERE o.scan_id=bot_scan_evaluations.scan_id AND o.final_result IS NOT NULL)
          OR skipped_count<>(SELECT COUNT(*) FROM bot_opportunity_decisions o
            WHERE o.scan_id=bot_scan_evaluations.scan_id AND o.final_result IS NOT NULL
              AND o.state<>'failed' AND o.final_result NOT IN ('failed','accepted'))
          OR failure_count<>(SELECT COUNT(*) FROM bot_opportunity_decisions o
            WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed'))
          OR failing_candidate_indexes<>COALESCE((SELECT json_group_array(candidate_index) FROM
            (SELECT candidate_index FROM bot_opportunity_decisions o
              WHERE o.scan_id=bot_scan_evaluations.scan_id AND (o.state='failed' OR o.final_result='failed')
              ORDER BY candidate_index)), '[]'))`);
      await db.execute({
        sql: `INSERT INTO bot_consumer_schema_migrations(name,completed_at) VALUES (?,?)`,
        args: ['bug181-reset-candidate-reconciliation-v2', new Date().toISOString()],
      });
    }
    schemaReady = true;
  } finally {
    db.close();
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function candidateIndexesFromScanRow(row: Record<string, unknown> | undefined, decisionIndexes: number[]): number[] {
  const raw = parseJson(row?.raw_result);
  const allArbs = recordObject(raw)?.allArbs;
  if (Array.isArray(allArbs)) return allArbs.map((_, candidateIndex) => candidateIndex);
  const positiveArbCount = Number(row?.positive_arb_count ?? 0);
  const inferredCount = Number.isSafeInteger(positiveArbCount) && positiveArbCount > 0 ? positiveArbCount : 0;
  const indexes = new Set(decisionIndexes);
  for (let candidateIndex = 0; candidateIndex < inferredCount; candidateIndex++) indexes.add(candidateIndex);
  return [...indexes].sort((a, b) => a - b);
}

async function refreshPersistedScanEvaluation(db: ReturnType<typeof createClient>, scanId: number): Promise<BotScanEvaluationEnvelope> {
  const [scanResult, decisionResult, candidateResult] = await Promise.all([
    db.execute({ sql: 'SELECT raw_result,positive_arb_count,scanned_at FROM scan_results WHERE id=?', args: [scanId] }),
    db.execute({ sql: 'SELECT * FROM bot_scan_decisions WHERE scan_id=?', args: [scanId] }),
    db.execute({ sql: 'SELECT * FROM bot_opportunity_decisions WHERE scan_id=? ORDER BY candidate_index', args: [scanId] }),
  ]);
  const decisionRow = decisionResult.rows[0] as unknown as Record<string, unknown> | undefined;
  const candidateDecisions: EvaluationCandidateDecision[] = (candidateResult.rows as unknown as Record<string, unknown>[]).map((row) => ({
    candidateIndex: Number(row.candidate_index),
    state: String(row.state),
    reasonCode: String(row.reason_code),
    finalResult: row.final_result == null ? null : String(row.final_result),
    executionId: row.execution_id == null ? null : Number(row.execution_id),
    details: parseJson(row.details),
  }));
  const scanRow = scanResult.rows[0] as unknown as Record<string, unknown> | undefined;
  const canonicalPositiveArbCount = Number(scanRow?.positive_arb_count ?? 0);
  const persistedScanDecision: EvaluationScanDecision | null = decisionRow ? {
    state: String(decisionRow.state),
    reasonCode: String(decisionRow.reason_code),
    reason: String(decisionRow.reason),
    receivedAt: decisionRow.received_at == null ? null : String(decisionRow.received_at),
    updatedAt: decisionRow.updated_at == null ? null : String(decisionRow.updated_at),
    attempts: Number(decisionRow.attempts ?? 0),
    placementCount: Number(decisionRow.placement_count ?? 0),
    details: parseJson(decisionRow.details),
  } : Number.isFinite(canonicalPositiveArbCount) && canonicalPositiveArbCount <= 0 ? {
    state: 'criteria_rejected',
    reasonCode: 'no_positive_arb',
    reason: 'No Positive Arb — BotTrader not applicable',
    receivedAt: scanRow?.scanned_at == null ? null : String(scanRow.scanned_at),
    updatedAt: scanRow?.scanned_at == null ? null : String(scanRow.scanned_at),
    attempts: 0,
    placementCount: 0,
    details: null,
  } : null;
  const envelope = summarizeBotScanEvaluation({
    scanId,
    candidateIndexes: candidateIndexesFromScanRow(
      scanRow,
      candidateDecisions.map((item) => item.candidateIndex),
    ),
    scanDecision: persistedScanDecision,
    candidateDecisions,
  });
  await db.execute({
    sql: `INSERT INTO bot_scan_evaluations
      (scan_id,status,completed,reason,started_at,completed_at,updated_at,settings_version,
       candidate_count,evaluated_count,eligible_count,placement_attempt_count,placed_count,skipped_count,failure_count,
       missing_candidate_indexes,failing_candidate_indexes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(scan_id) DO UPDATE SET
        status=excluded.status,completed=excluded.completed,reason=excluded.reason,
        started_at=excluded.started_at,completed_at=excluded.completed_at,updated_at=excluded.updated_at,
        settings_version=excluded.settings_version,candidate_count=excluded.candidate_count,
        evaluated_count=excluded.evaluated_count,eligible_count=excluded.eligible_count,
        placement_attempt_count=excluded.placement_attempt_count,placed_count=excluded.placed_count,
        skipped_count=excluded.skipped_count,failure_count=excluded.failure_count,
        missing_candidate_indexes=excluded.missing_candidate_indexes,failing_candidate_indexes=excluded.failing_candidate_indexes`,
    args: [
      envelope.scanId, envelope.status, envelope.botTraderEvaluationCompleted ? 1 : 0, envelope.reason,
      envelope.startedAt, envelope.completedAt, envelope.updatedAt, envelope.settingsVersion,
      envelope.candidateCount, envelope.evaluatedCount, envelope.eligibleCount, envelope.placementAttemptCount,
      envelope.placedCount, envelope.skippedCount, envelope.failureCount,
      JSON.stringify(envelope.missingCandidateIndexes), JSON.stringify(envelope.failingCandidateIndexes),
    ],
  });
  return envelope;
}

function parseDepth(value: unknown): number {
  if (finite(value)) return value > 0 ? value : 0;
  if (typeof value !== 'string') return 0;
  const match = value.trim().replace(/^\$/, '').match(/^(\d[\d,]*(?:\.\d+)?)\s*([KMB]?)$/i);
  if (!match) return 0;
  let amount = Number(match[1].replaceAll(',', ''));
  const suffix = match[2].toUpperCase();
  if (suffix === 'K') amount *= 1_000;
  if (suffix === 'M') amount *= 1_000_000;
  if (suffix === 'B') amount *= 1_000_000_000;
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function parseBotScanCandidate(value: unknown, expiryDate?: string | null, category?: string): BotScanCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const fees = row.fees && typeof row.fees === 'object' ? row.fees as Record<string, unknown> : null;
  const pmFee = fees?.pmFee ?? fees?.polymarketFee;
  const quote = (candidate: unknown): ExecutableBookQuote | undefined =>
    isExecutableQuoteConsistent(
      candidate as ExecutableBookQuote | undefined,
      'buy',
      (candidate as ExecutableBookQuote | undefined)?.requestedQuantityMicros ?? 0,
    )
      ? candidate as ExecutableBookQuote
      : undefined;
  if (typeof row.artist !== 'string' || typeof row.strategy !== 'string'
      || !finite(row.roiPct) || !finite(row.expectedProfit)
      || typeof row.kalshiTicker !== 'string' || typeof row.pmConditionId !== 'string') return null;
  const audit = auditArbClassification(
    row.strategy,
    row.arbType === 'direct' || row.arbType === 'cross' || row.arbType === 'internal' ? row.arbType : null,
  );
  // Persisted cross rows do not carry auditable mutual-exclusivity and
  // exhaustiveness evidence, so the bot may consume direct rows only.
  if (!audit.valid || audit.canonicalType !== 'direct') return null;
  return {
    outcome: row.artist,
    kalshiMarketQuestion: typeof row.kalshiMarketQuestion === 'string' ? row.kalshiMarketQuestion : null,
    pmMarketQuestion: typeof row.pmMarketQuestion === 'string' ? row.pmMarketQuestion : null,
    kalshiOutcomeLabel: typeof row.kalshiOutcomeLabel === 'string' ? row.kalshiOutcomeLabel : null,
    pmOutcomeLabel: typeof row.pmOutcomeLabel === 'string' ? row.pmOutcomeLabel : null,
    relationshipVerified: row.relationshipVerified === true,
    relationshipState: row.relationshipState === 'verified_complementary'
      || row.relationshipState === 'same_direction'
      || row.relationshipState === 'invalid'
      || row.relationshipState === 'legacy_unknown' ? row.relationshipState : undefined,
    relationshipExplanation: typeof row.relationshipExplanation === 'string' ? row.relationshipExplanation : null,
    kalshiSide: row.kalshiSide === 'yes' || row.kalshiSide === 'no' ? row.kalshiSide : undefined,
    pmSide: row.pmSide === 'yes' || row.pmSide === 'no' ? row.pmSide : undefined,
    strategy: row.strategy,
    propositionRelationship: row.propositionRelationship && typeof row.propositionRelationship === 'object'
      ? row.propositionRelationship as PropositionRelationship
      : null,
    roiPct: row.roiPct,
    apyPct: finite(row.apyPct) ? row.apyPct : null,
    expectedProfit: row.expectedProfit,
    kalshiStake: finite(row.kalshiStake) ? row.kalshiStake : 0,
    pmStake: finite(row.pmStake) ? row.pmStake : 0,
    kalshiTicker: row.kalshiTicker,
    pmConditionId: row.pmConditionId,
    pmYesTokenId: typeof row.pmYesTokenId === 'string' ? row.pmYesTokenId : null,
    pmNoTokenId: typeof row.pmNoTokenId === 'string' ? row.pmNoTokenId : null,
    kalshiYesAsk: finite(row.kalshiYesAsk) ? row.kalshiYesAsk : null,
    kalshiNoAsk: finite(row.kalshiNoAsk) ? row.kalshiNoAsk : null,
    // `pmYesPrice` may be a CLOB/Gamma midpoint and is never executable.
    pmYesAsk: finite(row.pmBestAsk) ? row.pmBestAsk : finite(row.pmYesAsk) ? row.pmYesAsk : null,
    pmNoAsk: finite(row.pmNoPrice) ? row.pmNoPrice : finite(row.pmNoAsk) ? row.pmNoAsk : null,
    kalshiYesDepth: parseDepth(row.kalshiYesDepth),
    kalshiNoDepth: parseDepth(row.kalshiNoDepth),
    pmYesDepth: parseDepth(row.pmYesDepth),
    pmNoDepth: parseDepth(row.pmNoDepth),
    kalshiYesExecutableQuote: quote(row.kalshiYesExecutableQuote),
    kalshiNoExecutableQuote: quote(row.kalshiNoExecutableQuote),
    pmYesExecutableQuote: quote(row.pmYesExecutableQuote),
    pmNoExecutableQuote: quote(row.pmNoExecutableQuote),
    pmYesMinOrderSize: finite(row.pmYesMinOrderSize) ? row.pmYesMinOrderSize as number : null,
    pmNoMinOrderSize: finite(row.pmNoMinOrderSize) ? row.pmNoMinOrderSize as number : null,
    pmYesTickSize: finite(row.pmYesTickSize) ? row.pmYesTickSize as number : null,
    pmNoTickSize: finite(row.pmNoTickSize) ? row.pmNoTickSize as number : null,
    executionStatus: row.executionStatus === 'executable' || row.executionStatus === 'non_executable' || row.executionStatus === 'unavailable'
      ? row.executionStatus
      : undefined,
    executionBlocker: typeof row.executionBlocker === 'string' ? row.executionBlocker : null,
    fees: fees && finite(fees.kalshiFee) && finite(pmFee) ? {
      kalshiFee: fees.kalshiFee,
      pmFee,
      ...(typeof fees.kalshiFeeDetails === 'string' ? { kalshiFeeDetails: fees.kalshiFeeDetails } : {}),
      ...(typeof fees.pmFeeDetails === 'string' ? { pmFeeDetails: fees.pmFeeDetails } : {}),
    } : null,
    expiryDate: typeof row.expiryDate === 'string' ? row.expiryDate : expiryDate,
    category: typeof row.category === 'string' ? row.category : category,
    stale: row.stale === true,
  };
}

function rowToScan(row: Record<string, unknown>): PersistedBotScan {
  const raw = parseJson(row.raw_result) as { allArbs?: unknown[]; expiryDate?: string; category?: string } | null;
  const candidates: BotScanCandidate[] = [];
  const rejectedCandidates: RejectedBotScanCandidate[] = [];
  for (const [candidateIndex, value] of (raw?.allArbs ?? []).entries()) {
    const parsed = parseBotScanCandidate(value, raw?.expiryDate, raw?.category);
    if (parsed) {
      candidates.push({ ...parsed, candidateIndex });
      continue;
    }
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const missingIds = typeof source.kalshiTicker !== 'string' || typeof source.pmConditionId !== 'string';
    rejectedCandidates.push({
      candidateIndex,
      outcome: typeof source.artist === 'string' ? source.artist : 'unknown',
      strategy: typeof source.strategy === 'string' ? source.strategy : 'unknown',
      reasonCode: missingIds ? 'missing_exact_ids' : 'malformed_candidate',
      reason: missingIds
        ? 'Discovered opportunity is missing exact Kalshi ticker or Polymarket condition ID'
        : 'Discovered opportunity failed required field or arbitrage-classification validation',
    });
  }
  return {
    id: Number(row.id),
    marketId: String(row.market_id),
    marketTitle: String(row.market_title || row.market_id),
    scannedAt: String(row.scanned_at),
    positiveArbCount: Number(row.positive_arb_count ?? 0),
    candidates,
    rejectedCandidates,
  };
}

function rowToDecision(row: Record<string, unknown>): BotScanDecision {
  return {
    scanId: Number(row.scan_id), idempotencyKey: String(row.idempotency_key), source: row.source as BotScanSource,
    state: row.state as BotScanDecisionState, reasonCode: String(row.reason_code), reason: String(row.reason),
    receivedAt: String(row.received_at), updatedAt: String(row.updated_at), attempts: Number(row.attempts ?? 0),
    placementCount: Number(row.placement_count ?? 0), details: parseJson(row.details),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
  };
}

async function loadScan(scanId: number): Promise<PersistedBotScan | null> {
  await ensureSchema();
  const db = await dbClient();
  try {
    const result = await db.execute({ sql: "SELECT * FROM scan_results WHERE id = ? AND scan_status = 'completed'", args: [scanId] });
    const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
    return row ? rowToScan(row) : null;
  } finally { db.close(); }
}

async function listBacklog(limit: number): Promise<PersistedBotScan[]> {
  await ensureSchema();
  const db = await dbClient();
  try {
    const result = await db.execute({
      sql: `SELECT s.* FROM scan_results s
        LEFT JOIN bot_scan_decisions d ON d.scan_id = s.id
        LEFT JOIN bot_scan_cursor c ON c.consumer = 'bot_trader'
        WHERE s.scan_status = 'completed' AND (
          (s.id > COALESCE(c.last_scan_id, 0) AND d.scan_id IS NULL) OR d.state = 'received'
          OR d.state = 'placement_attempted'
          OR (d.state = 'failed' AND d.reason_code = 'revalidation_failed')
        )
        ORDER BY s.id ASC LIMIT ?`,
      args: [limit],
    });
    return (result.rows as unknown as Record<string, unknown>[]).map(rowToScan);
  } finally { db.close(); }
}

async function acquire(scan: PersistedBotScan, source: BotScanSource): Promise<BotScanDecision | null> {
  await ensureSchema();
  const db = await dbClient();
  const owner = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 15 * 60_000).toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO bot_scan_decisions
        (scan_id,idempotency_key,source,state,reason_code,reason,received_at,updated_at)
        VALUES (?,?,?,'received','scan_received','Persisted completed scan received',?,?)
        ON CONFLICT(scan_id) DO NOTHING`,
      args: [scan.id, `scan:${scan.id}`, source, now.toISOString(), now.toISOString()],
    });
    const claimed = await db.execute({
      sql: `UPDATE bot_scan_decisions SET lease_owner=?, lease_expires_at=?, source=?,
        state=CASE WHEN state='placement_attempted' THEN state ELSE 'received' END,
        reason_code=CASE WHEN state='placement_attempted' THEN reason_code ELSE 'scan_received' END,
        reason=CASE WHEN state='placement_attempted' THEN reason ELSE 'Persisted completed scan received' END,
        updated_at=?
        WHERE scan_id=?
          AND (state IN ('received','placement_attempted') OR (state='failed' AND reason_code='revalidation_failed'))
          AND (lease_owner IS NULL OR lease_expires_at < ?)
        RETURNING *`,
      args: [owner, expires, source, now.toISOString(), scan.id, now.toISOString()],
    });
    const row = claimed.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) return null;
    const decision = rowToDecision(row);
    await appendEvent(
      db,
      scan.id,
      source,
      decision.state,
      decision.state === 'placement_attempted' ? 'interrupted_placement_detected' : 'scan_received',
      decision.state === 'placement_attempted'
        ? 'Expired placement attempt was claimed for fail-closed reconciliation'
        : 'Persisted completed scan received',
      null,
    );
    await refreshPersistedScanEvaluation(db, scan.id);
    return decision;
  } finally { db.close(); }
}

async function appendEvent(db: ReturnType<typeof createClient>, scanId: number, source: BotScanSource, state: BotScanDecisionState, code: string, reason: string, details: unknown) {
  await db.execute({
    sql: `INSERT INTO bot_scan_decision_events (scan_id,source,state,reason_code,reason,created_at,details) VALUES (?,?,?,?,?,?,?)`,
    args: [scanId, source, state, code, reason, new Date().toISOString(), details == null ? null : JSON.stringify(details)],
  });
}

async function updateDecision(scanId: number, leaseOwner: string, update: DecisionUpdate, release: boolean): Promise<BotScanDecision> {
  await ensureSchema();
  const db = await dbClient();
  try {
    const current = await db.execute({ sql: 'SELECT source, attempts, placement_count FROM bot_scan_decisions WHERE scan_id=? AND lease_owner=?', args: [scanId, leaseOwner] });
    const prior = current.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!prior) throw new Error(`Bot scan ${scanId} lease was lost before decision update`);
    const now = new Date().toISOString();
    const result = await db.execute({
      sql: `UPDATE bot_scan_decisions SET state=?,reason_code=?,reason=?,updated_at=?,attempts=?,placement_count=?,details=?,
        lease_owner=${release ? 'NULL' : 'lease_owner'},lease_expires_at=${release ? 'NULL' : 'lease_expires_at'} WHERE scan_id=? AND lease_owner=? RETURNING *`,
      args: [update.state, update.reasonCode, update.reason, now, update.attempts ?? Number(prior.attempts ?? 0), update.placementCount ?? Number(prior.placement_count ?? 0), update.details == null ? null : JSON.stringify(update.details), scanId, leaseOwner],
    });
    const updated = result.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!updated) throw new Error(`Bot scan ${scanId} lease expired during decision update`);
    await appendEvent(db, scanId, prior.source as BotScanSource, update.state, update.reasonCode, update.reason, update.details);
    await refreshPersistedScanEvaluation(db, scanId);
    return rowToDecision(updated);
  } finally { db.close(); }
}

async function recordReplay(scanId: number, source: BotScanSource) {
  await ensureSchema();
  const db = await dbClient();
  try { await appendEvent(db, scanId, source, 'duplicate_replay', 'duplicate_replay', 'Scan was already claimed or processed; no duplicate placement was attempted', null); }
  finally { db.close(); }
}

async function recordCandidateDecision(scan: PersistedBotScan, candidateIndex: number, candidate: BotScanCandidate, state: string, reasonCode: string, reason: string, details?: unknown) {
  await ensureSchema();
  const db = await dbClient();
  const now = new Date().toISOString();
  const audit = details && typeof details === 'object' ? details as Record<string, unknown> : null;
  const configVersion = typeof audit?.configVersion === 'string' ? audit.configVersion : null;
  const finalResult = audit?.final === true ? state : null;
  const executionId = typeof audit?.executionId === 'number' && Number.isSafeInteger(audit.executionId) ? audit.executionId : null;
  try {
    await db.execute({
      sql: `INSERT INTO bot_opportunity_decisions
        (scan_id,candidate_index,market_id,outcome,strategy,state,reason_code,reason,roi_pct,apy_pct,created_at,updated_at,details,opportunity_id,threshold_config_version,final_result,execution_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(scan_id,candidate_index) DO UPDATE SET
          state=excluded.state,reason_code=excluded.reason_code,reason=excluded.reason,
          roi_pct=excluded.roi_pct,apy_pct=excluded.apy_pct,updated_at=excluded.updated_at,details=excluded.details,
          opportunity_id=excluded.opportunity_id,threshold_config_version=excluded.threshold_config_version,
          final_result=excluded.final_result,execution_id=excluded.execution_id`,
      args: [scan.id, candidateIndex, scan.marketId, candidate.outcome, candidate.strategy, state, reasonCode, reason,
        candidate.roiPct, candidate.apyPct ?? null, now, now, details == null ? null : JSON.stringify(details),
        `scan:${scan.id}:opportunity:${candidateIndex}`, configVersion, finalResult, executionId],
    });
    await refreshPersistedScanEvaluation(db, scan.id);
  } finally { db.close(); }
}

async function advanceCursor() {
  await ensureSchema();
  const db = await dbClient();
  const now = new Date().toISOString();
  try {
    const contiguous = await db.execute(`WITH current AS (
        SELECT COALESCE(MAX(last_scan_id),0) AS last_scan_id FROM bot_scan_cursor WHERE consumer='bot_trader'
      ) SELECT MAX(s.id) AS last_scan_id
      FROM scan_results s
      CROSS JOIN current c
      WHERE s.scan_status='completed' AND s.id>c.last_scan_id AND NOT EXISTS (
        SELECT 1 FROM scan_results gap
        LEFT JOIN bot_scan_decisions d ON d.scan_id=gap.id
        WHERE gap.scan_status='completed' AND gap.id>c.last_scan_id AND gap.id<=s.id AND (
          d.scan_id IS NULL OR d.state IN ('received','placement_attempted')
          OR (d.state='partial_or_unhedged' AND d.reason_code='interrupted_placement_reconciliation_required')
          OR (d.state='failed' AND d.reason_code='revalidation_failed')
        )
      )`);
    const contiguousScanId = Number(contiguous.rows[0]?.last_scan_id ?? 0);
    await db.execute({
      sql: `INSERT INTO bot_scan_cursor (consumer,last_scan_id,updated_at) VALUES ('bot_trader',?,?)
        ON CONFLICT(consumer) DO UPDATE SET last_scan_id=MAX(last_scan_id,excluded.last_scan_id),updated_at=excluded.updated_at`,
      args: [contiguousScanId, now],
    });
  } finally { db.close(); }
}

async function revalidate(scan: PersistedBotScan): Promise<BotScanCandidate[]> {
  const [{ getSavedMarketById }, { getManualMatches }, { refreshSingleMarket }] = await Promise.all([
    import('./persistence'), import('./manual-matches'), import('@/app/api/saved-markets/refresh/refresh-single'),
  ]);
  const market = await getSavedMarketById(scan.marketId);
  if (!market) throw new Error(`Saved market ${scan.marketId} is unavailable for exact revalidation`);
  const refreshed = await refreshSingleMarket(market, await getManualMatches());
  return (refreshed.allArbs as unknown[])
    .map((item) => parseBotScanCandidate(item, refreshed.expiryDate, market.category))
    .filter((item): item is BotScanCandidate => item != null);
}

async function reserveOpportunity(candidate: BotScanCandidate, executionMode: BotPositionExecutionMode): Promise<boolean> {
  const { reserveBotMarketPair } = await import('./bot-positions');
  return reserveBotMarketPair(candidate.kalshiTicker, candidate.pmConditionId, executionMode);
}

async function releaseOpportunity(candidate: BotScanCandidate, executionMode: BotPositionExecutionMode): Promise<void> {
  const { releaseBotMarketPair } = await import('./bot-positions');
  await releaseBotMarketPair(candidate.kalshiTicker, candidate.pmConditionId, executionMode);
}

async function retainOpportunityForExposure(candidate: BotScanCandidate, executionMode: BotPositionExecutionMode): Promise<void> {
  const { retainBotMarketPairForExposure } = await import('./bot-positions');
  await retainBotMarketPairForExposure(candidate.kalshiTicker, candidate.pmConditionId, executionMode);
}

const productionDeps: BotScanConsumerDeps = {
  now: () => new Date(), getSettings: getBotSettings, resolveExecutionMode: resolveBotExecutionMode, loadScan, listBacklog, acquire,
  transition: (id, owner, update) => updateDecision(id, owner, update, false),
  finish: (id, owner, update) => updateDecision(id, owner, update, true),
  recordReplay, advanceCursor, revalidate, execute: maybeExecuteBotTrade,
  reserveOpportunity, releaseOpportunity, retainOpportunityForExposure, recordCandidateDecision,
  reportModeBlock: async (scan, settings) => {
    const readiness = await getBotExecutionReadiness(settings);
    const reason = `Production execution blocked: ${readiness.blockedReasons.join('; ')}`;
    const alert = await sendBotOperationalAlert({
      pairId: scan.marketId,
      marketTitle: scan.marketTitle,
      outcome: scan.candidates[0]?.outcome ?? 'scan-level readiness',
    }, reason, `scan:${scan.id}:production-blocked`);
    return { reason, alertDurable: alert.durable, alertError: alert.error };
  },
};

const consumer = createBotScanConsumer(productionDeps);

export async function consumePersistedBotScan(scanId: number, source: BotScanSource): Promise<BotScanDecision> {
  return consumer.consume(scanId, source);
}

export async function processBotScanBacklog(limit = 100): Promise<BotScanDecision[]> {
  return consumer.processBacklog(limit);
}

export async function getBotScanDecisions(limit = 100): Promise<BotScanDecision[]> {
  await ensureSchema();
  const db = await dbClient();
  try {
    const result = await db.execute({ sql: 'SELECT * FROM bot_scan_decisions ORDER BY scan_id DESC LIMIT ?', args: [Math.min(500, Math.max(1, limit))] });
    return (result.rows as unknown as Record<string, unknown>[]).map(rowToDecision);
  } finally { db.close(); }
}

function parseIndexArray(value: unknown): number[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is number => typeof item === 'number' && Number.isSafeInteger(item))
    : [];
}

function rowToEvaluation(row: Record<string, unknown>): BotScanEvaluationEnvelope {
  return {
    scanId: Number(row.scan_id),
    status: row.status as BotTraderEvaluationStatus,
    botTraderEvaluationCompleted: Number(row.completed) === 1,
    reason: String(row.reason),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
    settingsVersion: row.settings_version == null ? null : String(row.settings_version),
    candidateCount: Number(row.candidate_count ?? 0),
    evaluatedCount: Number(row.evaluated_count ?? 0),
    eligibleCount: Number(row.eligible_count ?? 0),
    placementAttemptCount: Number(row.placement_attempt_count ?? 0),
    placedCount: Number(row.placed_count ?? 0),
    skippedCount: Number(row.skipped_count ?? 0),
    failureCount: Number(row.failure_count ?? 0),
    missingCandidateIndexes: parseIndexArray(row.missing_candidate_indexes),
    failingCandidateIndexes: parseIndexArray(row.failing_candidate_indexes),
  };
}

export async function getBotScanEvaluationSummaries(scanIds: number[]): Promise<Map<number, BotScanEvaluationEnvelope>> {
  await ensureSchema();
  const ids = [...new Set(scanIds)].filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 500);
  const evaluations = new Map<number, BotScanEvaluationEnvelope>();
  if (ids.length === 0) return evaluations;
  const db = await dbClient();
  try {
    const placeholders = ids.map(() => '?').join(',');
    const read = async () => db.execute({
      sql: `SELECT * FROM bot_scan_evaluations WHERE scan_id IN (${placeholders})`,
      args: ids,
    });
    let rows = await read();
    const found = new Set(rows.rows.map((row) => Number(row.scan_id)));
    for (const scanId of ids) {
      if (!found.has(scanId)) await refreshPersistedScanEvaluation(db, scanId);
    }
    if (found.size !== ids.length) rows = await read();
    for (const row of rows.rows as unknown as Record<string, unknown>[]) {
      const evaluation = rowToEvaluation(row);
      evaluations.set(evaluation.scanId, evaluation);
    }
    return evaluations;
  } finally { db.close(); }
}

export async function getBotScanHealth(): Promise<{
  latestCompletedScanId: number | null;
  latestCompletedScanAt: string | null;
  latestPositiveScanId: number | null;
  latestPositiveScanAt: string | null;
  cursorScanId: number;
  cursorUpdatedAt: string | null;
  latestDecisionScanId: number | null;
  latestDecisionAt: string | null;
  pendingScans: number;
  cursorLag: number;
  opportunitiesEvaluated: number;
  eligibleCount: number;
  lastExecutionOrSkip: { scanId: number; state: string; reason: string; at: string } | null;
  inProgress: { scanId: number; state: 'received'; reason: string; at: string } | null;
}> {
  await ensureSchema();
  const db = await dbClient();
  try {
    const [latest, latestPositive, cursor, decision, terminalDecision, inProgress, pending, opportunityCounts] = await Promise.all([
      db.execute("SELECT id,scanned_at FROM scan_results WHERE scan_status='completed' ORDER BY id DESC LIMIT 1"),
      db.execute("SELECT id,scanned_at FROM scan_results WHERE scan_status='completed' AND positive_arb_count>0 ORDER BY id DESC LIMIT 1"),
      db.execute("SELECT last_scan_id,updated_at FROM bot_scan_cursor WHERE consumer='bot_trader'"),
      db.execute('SELECT scan_id,state,reason,updated_at FROM bot_scan_decisions ORDER BY scan_id DESC LIMIT 1'),
      db.execute("SELECT scan_id,state,reason,updated_at FROM bot_scan_decisions WHERE state <> 'received' ORDER BY scan_id DESC LIMIT 1"),
      db.execute("SELECT scan_id,state,reason,updated_at FROM bot_scan_decisions WHERE state = 'received' ORDER BY scan_id DESC LIMIT 1"),
      db.execute(`SELECT COUNT(*) AS count FROM scan_results s
        LEFT JOIN bot_scan_decisions d ON d.scan_id=s.id
        LEFT JOIN bot_scan_cursor c ON c.consumer='bot_trader'
        WHERE s.scan_status='completed' AND s.positive_arb_count>0 AND (
          (s.id > COALESCE(c.last_scan_id,0) AND d.scan_id IS NULL) OR d.state IN ('received','placement_attempted')
          OR (d.state='partial_or_unhedged' AND d.reason_code='interrupted_placement_reconciliation_required')
          OR (d.state='failed' AND d.reason_code='revalidation_failed'))`),
      db.execute(`SELECT COUNT(*) AS evaluated,
        SUM(CASE WHEN state IN ('eligible','accepted') THEN 1 ELSE 0 END) AS eligible
        FROM bot_opportunity_decisions`),
    ]);
    const latestDecision = decision.rows[0];
    const latestTerminalDecision = terminalDecision.rows[0];
    const latestInProgress = inProgress.rows[0];
    return {
      latestCompletedScanId: latest.rows[0]?.id == null ? null : Number(latest.rows[0].id),
      latestCompletedScanAt: latest.rows[0]?.scanned_at == null ? null : String(latest.rows[0].scanned_at),
      latestPositiveScanId: latestPositive.rows[0]?.id == null ? null : Number(latestPositive.rows[0].id),
      latestPositiveScanAt: latestPositive.rows[0]?.scanned_at == null ? null : String(latestPositive.rows[0].scanned_at),
      cursorScanId: Number(cursor.rows[0]?.last_scan_id ?? 0),
      cursorUpdatedAt: cursor.rows[0]?.updated_at == null ? null : String(cursor.rows[0].updated_at),
      latestDecisionScanId: latestDecision?.scan_id == null ? null : Number(latestDecision.scan_id),
      latestDecisionAt: latestDecision?.updated_at == null ? null : String(latestDecision.updated_at),
      pendingScans: Number(pending.rows[0]?.count ?? 0),
      cursorLag: Number(pending.rows[0]?.count ?? 0),
      opportunitiesEvaluated: Number(opportunityCounts.rows[0]?.evaluated ?? 0),
      eligibleCount: Number(opportunityCounts.rows[0]?.eligible ?? 0),
      lastExecutionOrSkip: latestTerminalDecision?.scan_id == null ? null : {
        scanId: Number(latestTerminalDecision.scan_id),
        state: String(latestTerminalDecision.state),
        reason: String(latestTerminalDecision.reason),
        at: String(latestTerminalDecision.updated_at),
      },
      inProgress: latestInProgress?.scan_id == null ? null : {
        scanId: Number(latestInProgress.scan_id),
        state: 'received',
        reason: String(latestInProgress.reason),
        at: String(latestInProgress.updated_at),
      },
    };
  } finally { db.close(); }
}

export async function persistAndConsumeBotScan(
  marketId: string,
  result: Parameters<typeof import('./persistence').saveScanResult>[1],
  source: BotScanSource,
): Promise<{ id: number; decision: BotScanDecision | null; backlogProcessed: number }> {
  const { saveScanResult } = await import('./persistence');
  return createPersistedBotScanPublisher({ saveScanResult, consumePersistedBotScan })(marketId, result, source);
}

export function createPersistedBotScanPublisher(deps: {
  saveScanResult: typeof import('./persistence').saveScanResult;
  consumePersistedBotScan: typeof consumePersistedBotScan;
}) {
  return async (
    marketId: string,
    result: Parameters<typeof import('./persistence').saveScanResult>[1],
    source: BotScanSource,
  ): Promise<{ id: number; decision: BotScanDecision; backlogProcessed: number }> => {
    // The inserted scan_results row is the canonical Logs completion event.
    // Consume only after its durable ID exists; Ragnar remains a restart-safe
    // catch-up reader for failures and process interruption.
    const saved = await deps.saveScanResult(marketId, result);
    const decision = await deps.consumePersistedBotScan(saved.id, source);
    return { ...saved, decision, backlogProcessed: 0 };
  };
}
