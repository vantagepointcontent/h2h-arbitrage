import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  createBotScanConsumer,
  createPersistedBotScanPublisher,
  parseBotScanCandidate,
  summarizeBotScanEvaluation,
  type BotScanCandidate,
  type BotScanConsumerDeps,
  type BotScanDecision,
  type BotScanDecisionState,
  type PersistedBotScan,
} from './bot-scan-consumer';
import { buildExecutionRequest, type BotExecutionResult, type BotSettings } from './bot-trader';
import type { PropositionRelationship } from './proposition-identity';

vi.mock('./proposition-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proposition-registry')>();
  return {
    ...actual,
    resolveCanonicalPropositionRelationship: (relationship: PropositionRelationship | null | undefined) => relationship ?? null,
  };
});
import { quoteOneShareFromTopAsk, walkExecutableBook } from './executable-book';

function settings(overrides: Partial<BotSettings> = {}): BotSettings {
  return {
    enabled: true,
    mode: 'paper',
    selectionMethod: 'hybrid',
    minRoiPct: 2,
    minApyPct: 0,
    minDepthUsd: 0.5,
    minSharesPerLeg: 1,
    maxExpiryDays: 365,
    maxTradesPerDay: 10,
    ...overrides,
  };
}

function candidate(overrides: Partial<BotScanCandidate> = {}): BotScanCandidate {
  const result: BotScanCandidate = {
    outcome: 'Team A',
    kalshiMarketQuestion: 'Will Team A win on Kalshi?',
    pmMarketQuestion: 'Will Team A win on Polymarket?',
    kalshiOutcomeLabel: 'Team A',
    pmOutcomeLabel: 'Team A',
    relationshipVerified: true,
    relationshipState: 'verified_complementary',
    relationshipExplanation: 'Canonical matcher verification for exact legs.',
    kalshiSide: 'yes',
    pmSide: 'no',
    strategy: 'Buy YES Kalshi + NO PM',
    roiPct: 5,
    apyPct: 25,
    expectedProfit: 5,
    kalshiStake: 45,
    pmStake: 50,
    kalshiTicker: 'KXTEST-A',
    pmConditionId: 'pm-condition-a',
    pmYesTokenId: 'pm-yes-token',
    pmNoTokenId: 'pm-no-token',
    kalshiYesAsk: 0.45,
    kalshiNoAsk: 0.56,
    pmYesAsk: 0.49,
    pmNoAsk: 0.50,
    kalshiYesDepth: 45,
    kalshiNoDepth: 56,
    pmYesDepth: 49,
    pmNoDepth: 50,
    pmYesMinOrderSize: 1,
    pmNoMinOrderSize: 1,
    pmYesTickSize: 0.01,
    pmNoTickSize: 0.01,
    fees: { kalshiFee: 0.4, pmFee: 0.1 },
    expiryDate: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
  const observedAt = '2026-08-11T12:00:10.000Z';
  if (!Object.prototype.hasOwnProperty.call(overrides, 'kalshiYesExecutableQuote')) {
    result.kalshiYesExecutableQuote = quoteOneShareFromTopAsk({
      price: result.kalshiYesAsk, depthUsd: result.kalshiYesDepth,
      tickSize: 0.01, minimumOrderSize: 1, depthTimestamp: observedAt,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'kalshiNoExecutableQuote')) {
    result.kalshiNoExecutableQuote = quoteOneShareFromTopAsk({
      price: result.kalshiNoAsk, depthUsd: result.kalshiNoDepth,
      tickSize: 0.01, minimumOrderSize: 1, depthTimestamp: observedAt,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'pmYesExecutableQuote')) {
    result.pmYesExecutableQuote = quoteOneShareFromTopAsk({
      price: result.pmYesAsk, depthUsd: result.pmYesDepth,
      tickSize: result.pmYesTickSize, minimumOrderSize: result.pmYesMinOrderSize,
      depthTimestamp: observedAt,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'pmNoExecutableQuote')) {
    result.pmNoExecutableQuote = quoteOneShareFromTopAsk({
      price: result.pmNoAsk, depthUsd: result.pmNoDepth,
      tickSize: result.pmNoTickSize, minimumOrderSize: result.pmNoMinOrderSize,
      depthTimestamp: observedAt,
    });
  }
  if (overrides.propositionRelationship === undefined) {
    const states = ['team a', 'not team a'];
    result.propositionRelationship = {
      schemaVersion: 1, state: 'verified_complementary', verificationSource: 'authoritative_platform_metadata',
      verifiedAt: '2026-08-11T12:00:00.000Z', parentEventId: 'event-1',
      resolutionRuleId: 'event-1-rules-v1', exhaustivePayoutStates: states,
      humanLabel: 'Kalshi YES Team A ↔ Polymarket NO Team A',
      legs: {
        kalshi: {
          platform: 'kalshi', platformMarketId: result.kalshiTicker, parentEventId: 'event-1',
          selectedOutcome: 'team a', contractSide: 'yes', payoutState: 'team a', eventPayoutStates: states,
          resolutionRuleId: 'event-1-rules-v1', humanLabel: 'Kalshi YES — Team A', marketQuestion: 'Will Team A win?', tokenId: null,
        },
        polymarket: {
          platform: 'polymarket', platformMarketId: result.pmConditionId, parentEventId: 'event-1',
          selectedOutcome: 'team a', contractSide: 'no', payoutState: 'not team a', eventPayoutStates: states,
          resolutionRuleId: 'event-1-rules-v1', humanLabel: 'Polymarket NO — Team A', marketQuestion: 'Will Team A win?',
          tokenId: result.pmNoTokenId!,
        },
      },
    };
  }
  return result;
}

function executableQuote(price: number) {
  return walkExecutableBook({
    side: 'buy',
    levels: [{ priceCents: price * 100, quantityMicros: 1_000_000 }],
    requestedQuantityMicros: 1_000_000,
    tickSizeCents: 1,
    minimumOrderQuantityMicros: 1_000_000,
    depthTimestamp: '2026-08-11T12:00:10.000Z',
  });
}

function scan(overrides: Partial<PersistedBotScan> = {}): PersistedBotScan {
  return {
    id: 41,
    marketId: 'pair-1',
    marketTitle: 'Test Market',
    scannedAt: '2026-08-11T12:00:00.000Z',
    positiveArbCount: 1,
    candidates: [candidate()],
    ...overrides,
  };
}

function execution(overrides: Partial<BotExecutionResult> = {}): BotExecutionResult {
  return {
    executed: true,
    dryRun: true,
    reason: 'Paper trade simulated',
    executionResult: { success: true, dryRun: true, steps: [], alerts: [], timestamp: new Date().toISOString() } as never,
    ...overrides,
  };
}

function scanDecision(scanId: number): BotScanDecision {
  return {
    scanId,
    idempotencyKey: `scan:${scanId}`,
    source: 'catch_up',
    state: 'criteria_rejected',
    reasonCode: 'no_opportunities',
    reason: 'No opportunities',
    receivedAt: '2026-08-11T12:00:10.000Z',
    updatedAt: '2026-08-11T12:00:10.000Z',
    attempts: 0,
    placementCount: 0,
    details: null,
  };
}

function harness(options: {
  scans?: PersistedBotScan[];
  current?: BotScanCandidate[] | Error;
  botSettings?: BotSettings;
  execute?: BotExecutionResult | Error;
  executionMode?: 'paper' | 'live';
  crashAfterPlacementTransition?: boolean;
} = {}) {
  const scans = options.scans ?? [scan()];
  const decisions = new Map<number, BotScanDecision>();
  const events: Array<{ scanId: number; state: BotScanDecisionState; code: string }> = [];
  const leases = new Set<number>();
  const opportunityReservations = new Set<string>();
  const opportunityDecisions: Array<{ candidateIndex: number; state: string; reasonCode: string; details?: unknown }> = [];
  const opportunityKey = (item: BotScanCandidate) => `${item.kalshiTicker}\0${item.pmConditionId}`;
  let cursor = 0;
  let crashAfterPlacementTransition = options.crashAfterPlacementTransition === true;
  const now = new Date('2026-08-11T12:00:10.000Z');

  const deps: BotScanConsumerDeps = {
    now: () => now,
    getSettings: vi.fn(async () => options.botSettings ?? settings()),
    resolveExecutionMode: vi.fn(async () => options.executionMode ?? 'paper'),
    loadScan: vi.fn(async (id) => scans.find((item) => item.id === id) ?? null),
    listBacklog: vi.fn(async () => scans.filter((item) => {
      const state = decisions.get(item.id)?.state;
      return !state || state === 'received' || state === 'disabled' || state === 'placement_attempted'
        || (state === 'failed' && decisions.get(item.id)?.reasonCode === 'revalidation_failed');
    })),
    acquire: vi.fn(async (item, source) => {
      if (leases.has(item.id)) return null;
      const existing = decisions.get(item.id);
      if (existing && !['received', 'disabled', 'placement_attempted'].includes(existing.state)
          && !(existing.state === 'failed' && existing.reasonCode === 'revalidation_failed')) return null;
      leases.add(item.id);
      const row: BotScanDecision = existing ?? {
        scanId: item.id,
        idempotencyKey: `scan:${item.id}`,
        source,
        state: 'received',
        reasonCode: 'scan_received',
        reason: 'Persisted positive-arbitrage scan received',
        receivedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        attempts: 0,
        placementCount: 0,
        details: null,
        leaseOwner: `lease-${item.id}-${source}`,
      };
      if (row.state !== 'placement_attempted') row.state = 'received';
      decisions.set(item.id, row);
      events.push({ scanId: item.id, state: 'received', code: 'scan_received' });
      return row;
    }),
    transition: vi.fn(async (id, _owner, update) => {
      const row = decisions.get(id)!;
      Object.assign(row, update, { updatedAt: now.toISOString() });
      events.push({ scanId: id, state: update.state, code: update.reasonCode });
      if (update.state === 'placement_attempted' && crashAfterPlacementTransition) {
        crashAfterPlacementTransition = false;
        throw new Error('simulated process termination after durable placement transition');
      }
      return row;
    }),
    finish: vi.fn(async (id, _owner, update) => {
      const row = decisions.get(id)!;
      Object.assign(row, update, { updatedAt: now.toISOString() });
      leases.delete(id);
      events.push({ scanId: id, state: update.state, code: update.reasonCode });
      return row;
    }),
    recordReplay: vi.fn(async (id) => {
      events.push({ scanId: id, state: 'duplicate_replay', code: 'duplicate_replay' });
    }),
    advanceCursor: vi.fn(async () => {
      for (const item of scans.sort((a, b) => a.id - b.id)) {
        if (item.id <= cursor) continue;
        const decision = decisions.get(item.id);
        if (!decision || decision.state === 'received' || decision.state === 'placement_attempted'
            || (decision.state === 'partial_or_unhedged' && decision.reasonCode === 'interrupted_placement_reconciliation_required')
            || (decision.state === 'failed' && decision.reasonCode === 'revalidation_failed')) break;
        cursor = item.id;
      }
    }),
    revalidate: vi.fn(async () => {
      if (options.current instanceof Error) throw options.current;
      return options.current ?? [candidate()];
    }),
    execute: vi.fn(async () => {
      if (options.execute instanceof Error) throw options.execute;
      return options.execute ?? execution();
    }),
    reserveOpportunity: vi.fn(async (item, mode) => {
      const key = `${mode}:${opportunityKey(item)}`;
      if (opportunityReservations.has(key)) return false;
      opportunityReservations.add(key);
      return true;
    }),
    releaseOpportunity: vi.fn(async (item, mode) => { opportunityReservations.delete(`${mode}:${opportunityKey(item)}`); }),
    retainOpportunityForExposure: vi.fn(async () => undefined),
    recordCandidateDecision: vi.fn(async (_scan, candidateIndex, _candidate, state, reasonCode, _reason, details) => {
      opportunityDecisions.push({ candidateIndex, state, reasonCode, details });
    }),
  };

  return { consumer: createBotScanConsumer(deps), deps, decisions, events, opportunityDecisions, cursor: () => cursor, leases };
}

describe('durable BotTrader scan consumer', () => {
  it('finishes SQLite connection PRAGMAs before issuing BotTrader queries', async () => {
    const source = await readFile(new URL('./bot-scan-consumer.ts', import.meta.url), 'utf8');

    expect(source).not.toContain("void db.execute('PRAGMA busy_timeout = 5000')");
    expect(source).toMatch(/async function dbClient\(\)[\s\S]+await db\.execute\('PRAGMA busy_timeout = 5000'\)[\s\S]+return db/);
  });

  it('marks a scan completed only when every contained candidate has a terminal audit decision', () => {
    const completed = summarizeBotScanEvaluation({
      scanId: 41,
      candidateIndexes: [0, 1],
      scanDecision: {
        state: 'placed', reasonCode: 'paper_placed', reason: 'one placement completed',
        receivedAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:10.000Z',
        attempts: 1, placementCount: 1, details: { configVersion: 'bot-settings-v1:test' },
      },
      candidateDecisions: [
        { candidateIndex: 0, state: 'accepted', reasonCode: 'execution_completed', finalResult: 'accepted', executionId: 9, details: { stage: 'execution' } },
        { candidateIndex: 1, state: 'rejected', reasonCode: 'scan_criteria_rejected', finalResult: 'rejected', executionId: null, details: { stage: 'scan' } },
      ],
    });

    expect(completed).toMatchObject({
      status: 'completed', botTraderEvaluationCompleted: true,
      settingsVersion: 'bot-settings-v1:test', candidateCount: 2, evaluatedCount: 2,
      eligibleCount: 1, placementAttemptCount: 1, placedCount: 1,
      skippedCount: 1, failureCount: 0, missingCandidateIndexes: [], failingCandidateIndexes: [],
    });

    const partial = summarizeBotScanEvaluation({
      scanId: 42,
      candidateIndexes: [0, 1],
      scanDecision: {
        state: 'partial_or_unhedged', reasonCode: 'partial_or_unhedged', reason: 'leg B failed',
        receivedAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:10.000Z',
        attempts: 1, placementCount: 0, details: { configVersion: 'bot-settings-v1:test' },
      },
      candidateDecisions: [
        { candidateIndex: 0, state: 'failed', reasonCode: 'execution_outcome_unknown', finalResult: 'failed', executionId: null, details: { stage: 'execution' } },
        { candidateIndex: 1, state: 'eligible', reasonCode: 'scan_eligible', finalResult: null, executionId: null, details: { stage: 'scan' } },
      ],
    });

    expect(partial).toMatchObject({
      status: 'partial', botTraderEvaluationCompleted: false,
      candidateCount: 2, evaluatedCount: 1, failureCount: 1,
      missingCandidateIndexes: [1], failingCandidateIndexes: [0],
    });
  });

  it('reconciles operator reset scan summaries from each terminal candidate audit', () => {
    const scanDecision = {
      state: 'reset_cleared',
      reasonCode: 'ops854_reset_cleared',
      reason: 'Cleared by OPS-854 reset baseline. Original state is retained in audit backup.',
      receivedAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
      attempts: 0,
      placementCount: 0,
      details: null,
    };
    expect(summarizeBotScanEvaluation({
      scanId: 43,
      candidateIndexes: [0, 1],
      scanDecision,
      candidateDecisions: [
        { candidateIndex: 0, state: 'skipped', reasonCode: 'ops854_reset_cleared', finalResult: 'reset_cleared', executionId: null, details: { stage: 'operator_reset', payloadUnavailable: 0 } },
        { candidateIndex: 1, state: 'skipped', reasonCode: 'ops854_reset_cleared', finalResult: 'reset_cleared', executionId: null, details: { stage: 'operator_reset', payloadUnavailable: 0 } },
      ],
    })).toMatchObject({
      status: 'completed',
      botTraderEvaluationCompleted: true,
      candidateCount: 2,
      evaluatedCount: 2,
      skippedCount: 2,
      failureCount: 0,
      missingCandidateIndexes: [],
      reason: 'Cleared by OPS-854 reset baseline. Original state is retained in audit backup.',
    });

    expect(summarizeBotScanEvaluation({
      scanId: 44,
      candidateIndexes: [0, 1],
      scanDecision,
      candidateDecisions: [
        { candidateIndex: 0, state: 'skipped', reasonCode: 'ops854_reset_cleared', finalResult: 'reset_cleared', executionId: null, details: { stage: 'operator_reset', payloadUnavailable: 0 } },
        { candidateIndex: 1, state: 'failed', reasonCode: 'reset_candidate_payload_unavailable', finalResult: 'reset_cleared', executionId: null, details: { stage: 'operator_reset', payloadUnavailable: 1 } },
      ],
    })).toMatchObject({
      status: 'failed',
      botTraderEvaluationCompleted: false,
      candidateCount: 2,
      evaluatedCount: 2,
      skippedCount: 1,
      failureCount: 1,
      missingCandidateIndexes: [],
      failingCandidateIndexes: [1],
    });
  });

  it('distinguishes disabled, failed, and legacy no-positive scan envelopes', () => {
    const common = {
      scanId: 41, candidateIndexes: [], candidateDecisions: [],
      scanDecision: {
        reasonCode: 'no_opportunities', reason: 'No opportunities',
        receivedAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:10.000Z',
        attempts: 0, placementCount: 0, details: { configVersion: 'bot-settings-v1:test' },
      },
    };
    expect(summarizeBotScanEvaluation({ ...common, scanDecision: { ...common.scanDecision, state: 'criteria_rejected' } }))
      .toMatchObject({ status: 'not_applicable_no_positive_arb', botTraderEvaluationCompleted: false, candidateCount: 0 });
    expect(summarizeBotScanEvaluation({ ...common, scanDecision: { ...common.scanDecision, state: 'disabled', reasonCode: 'bot_disabled' } }))
      .toMatchObject({ status: 'not_run_disabled', botTraderEvaluationCompleted: false });
    expect(summarizeBotScanEvaluation({ ...common, candidateIndexes: [0], scanDecision: { ...common.scanDecision, state: 'failed', reasonCode: 'revalidation_failed' } }))
      .toMatchObject({ status: 'failed', botTraderEvaluationCompleted: false, missingCandidateIndexes: [0] });
  });

  it('classifies a canonical no-positive-arb decision as terminal not-applicable without candidate gaps', () => {
    expect(summarizeBotScanEvaluation({
      scanId: 41,
      candidateIndexes: [0],
      scanDecision: {
        state: 'criteria_rejected',
        reasonCode: 'no_positive_arb',
        reason: 'No Positive Arb — BotTrader not applicable',
        receivedAt: '2026-08-11T12:00:00.000Z',
        updatedAt: '2026-08-11T12:00:10.000Z',
        attempts: 0,
        placementCount: 0,
        details: null,
      },
      candidateDecisions: [],
    })).toMatchObject({
      status: 'not_applicable_no_positive_arb',
      botTraderEvaluationCompleted: false,
      reason: 'No Positive Arb — BotTrader not applicable',
      candidateCount: 0,
      evaluatedCount: 0,
      eligibleCount: 0,
      placementAttemptCount: 0,
      placedCount: 0,
      skippedCount: 0,
      failureCount: 0,
      missingCandidateIndexes: [],
      failingCandidateIndexes: [],
    });
  });

  it('publishes a canonical Logs row before immediately consuming that exact scan', async () => {
    const calls: string[] = [];
    const publisher = createPersistedBotScanPublisher({
      saveScanResult: vi.fn(async () => { calls.push('saved'); return { id: 91 }; }),
      consumePersistedBotScan: vi.fn(async (scanId, source) => {
        calls.push(`consumed:${scanId}:${source}`);
        return { ...scanDecision(91), source };
      }),
    });

    await expect(publisher('pair-91', {} as never, 'scheduled')).resolves.toMatchObject({
      id: 91,
      decision: { scanId: 91, source: 'scheduled' },
      backlogProcessed: 0,
    });
    expect(calls).toEqual(['saved', 'consumed:91:scheduled']);
  });

  it('surfaces immediate-consumption failure after the canonical Logs row is durable', async () => {
    const saveScanResult = vi.fn(async () => ({ id: 92 }));
    const publisher = createPersistedBotScanPublisher({
      saveScanResult,
      consumePersistedBotScan: vi.fn(async () => { throw new Error('decision store unavailable'); }),
    });

    await expect(publisher('pair-92', {} as never, 'scan_api')).rejects.toThrow('decision store unavailable');
    expect(saveScanResult).toHaveBeenCalledOnce();
  });

  it.each([
    ['Same-platform YES+YES Kalshi: A + B', 'internal'],
    ['Same-platform YES+NO Kalshi: A', 'internal'],
    ['Buy YES Kalshi + NO PM', 'internal'],
  ])('fails closed before BotTrader for invalid or unsupported classification %s', (strategy, arbType) => {
    expect(parseBotScanCandidate({
      artist: 'A', strategy, arbType, roiPct: 5, expectedProfit: 5,
      kalshiTicker: 'KX-A', pmConditionId: 'pm-a',
      fees: { kalshiFee: 0.01, pmFee: 0.01 },
    })).toBeNull();
  });

  it('never promotes a Polymarket midpoint/yes price into an executable ask', () => {
    const parsed = parseBotScanCandidate({
      artist: 'A', strategy: 'Buy YES PM + NO Kalshi', roiPct: 5, expectedProfit: 5,
      kalshiTicker: 'KX-A', pmConditionId: 'pm-a', pmYesPrice: 0.42,
      fees: { kalshiFee: 0.01, pmFee: 0.01 },
    });
    expect(parsed?.pmYesAsk).toBeNull();
  });

  it('preserves a validated unavailable book reason across persisted scan parsing', () => {
    const unavailable = quoteOneShareFromTopAsk({
      price: 0.45,
      depthUsd: null,
      tickSize: 0.01,
      minimumOrderSize: 1,
      depthTimestamp: '2026-08-11T12:00:10.000Z',
      unavailableReason: 'missing_depth',
    });
    const parsed = parseBotScanCandidate({
      artist: 'A', strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct', roiPct: 5, expectedProfit: 5,
      kalshiTicker: 'KX-A', pmConditionId: 'pm-a',
      kalshiYesExecutableQuote: unavailable,
      requestedContracts: 1,
      evaluationContracts: 5,
      fees: { kalshiFee: 0.01, pmFee: 0.01 },
    });

    expect(parsed?.kalshiYesExecutableQuote).toMatchObject({ status: 'unavailable', reason: 'missing_depth' });
    expect(parsed).toMatchObject({ requestedContracts: 1, evaluationContracts: 5 });
  });

  it.each([
    ['source_unavailable', null, 'source_unavailable'],
    ['stale', '2026-08-11T12:00:10.000Z', 'stale_book'],
  ] as const)('round-trips %s Kalshi source provenance through persisted candidate parsing', (sourceStatus, observedAt, reason) => {
    const unavailable = {
      ...quoteOneShareFromTopAsk({
        price: 0.45, depthUsd: null, tickSize: 0.01, minimumOrderSize: 1,
        depthTimestamp: observedAt,
        unavailableReason: reason,
      }),
      sourceStatus,
      sourceAttemptedAt: '2026-08-11T12:05:10.000Z',
      sourceObservedAt: observedAt,
      sourceFailureKind: sourceStatus === 'stale' ? 'stale_snapshot' : 'rate_limited',
      sourceDetail: sourceStatus === 'stale' ? 'depth exceeded freshness budget' : 'Kalshi API error: 429',
    };
    const parsed = parseBotScanCandidate({
      artist: 'A', strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct', roiPct: 5, expectedProfit: 5,
      kalshiTicker: 'KX-A', pmConditionId: 'pm-a',
      kalshiYesExecutableQuote: unavailable,
      requestedContracts: 1,
      fees: { kalshiFee: 0.01, pmFee: 0.01 },
    });

    expect(parsed?.kalshiYesExecutableQuote).toMatchObject({
      status: 'unavailable', reason, sourceStatus, sourceObservedAt: observedAt,
    });
  });

  it('preserves authoritative fee values and calculation provenance from persisted candidates', () => {
    const parsed = parseBotScanCandidate({
      artist: 'A', strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct', roiPct: 5, expectedProfit: 5,
      kalshiTicker: 'KX-A', pmConditionId: 'pm-a',
      fees: {
        kalshiFee: 0.01,
        pmFee: 0.02,
        kalshiFeeDetails: 'Kalshi YES buy 1 @ $0.45 = $0.01',
        pmFeeDetails: 'Polymarket NO buy 1 @ $0.50 = $0.02',
      },
    });

    expect(parsed?.fees).toEqual({
      kalshiFee: 0.01,
      pmFee: 0.02,
      kalshiFeeDetails: 'Kalshi YES buy 1 @ $0.45 = $0.01',
      pmFeeDetails: 'Polymarket NO buy 1 @ $0.50 = $0.02',
    });
  });

  it('records received, placement_attempted, and placed for a normal paper scan', async () => {
    const h = harness();
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result.state).toBe('placed');
    expect(h.events.map((event) => event.state)).toEqual(['received', 'placement_attempted', 'placed']);
    expect(h.deps.execute).toHaveBeenCalledTimes(1);
    expect(h.deps.reserveOpportunity).toHaveBeenCalledWith(expect.any(Object), 'paper');
    expect(h.deps.execute).toHaveBeenCalledWith(expect.objectContaining({
      sourceScanId: 41,
      sourceOpportunityId: 'scan:41:opportunity:0',
      reservationMode: 'paper',
      kalshiMarketQuestion: 'Will Team A win on Kalshi?',
      pmMarketQuestion: 'Will Team A win on Polymarket?',
      kalshiOutcomeLabel: 'Team A',
      pmOutcomeLabel: 'Team A',
      relationshipVerified: true,
      relationshipState: 'verified_complementary',
      relationshipExplanation: 'Canonical matcher verification for exact legs.',
      kalshiSide: 'yes',
      pmSide: 'no',
    }));
    expect(result.placementCount).toBe(1);
  });

  it('treats the configured ROI threshold as inclusive and audits the exact opportunity lineage', async () => {
    const atBoundary = candidate({ roiPct: 2 });
    const h = harness({ scans: [scan({ candidates: [atBoundary] })], current: [atBoundary] });

    await expect(h.consumer.consume(41, 'scan_api')).resolves.toMatchObject({ state: 'placed' });
    expect(h.opportunityDecisions).toContainEqual(expect.objectContaining({
      candidateIndex: 0,
      state: 'eligible',
      reasonCode: 'scan_eligible',
      details: expect.objectContaining({
        opportunityId: 'scan:41:opportunity:0',
        scanId: 41,
      }),
    }));
  });

  it('keeps a venue-minimum-above-one candidate non-executable in paper mode', async () => {
    const venueMinimumCandidate = candidate({
      executionStatus: 'non_executable',
      executionBlocker: 'Polymarket NO minimum order is 5 shares; requested 1 share',
      pmNoMinOrderSize: 5,
      kalshiYesDepth: 2.25,
      pmNoDepth: 2.50,
    });
    const h = harness({
      scans: [scan({ candidates: [venueMinimumCandidate] })],
      current: [venueMinimumCandidate],
      botSettings: settings({ minSharesPerLeg: 1 }),
      executionMode: 'paper',
    });

    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({
      state: 'criteria_rejected',
      placementCount: 0,
    });
    expect(result.reason).toContain('canonical executable quantity 1');
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.opportunityDecisions).toContainEqual(expect.objectContaining({
      state: 'rejected',
      reasonCode: 'scan_criteria_rejected',
    }));
  });

  it('reports the real paper criteria instead of a legacy one-share scanner blocker', async () => {
    const venueMinimumCandidate = candidate({
      executionStatus: 'non_executable',
      executionBlocker: 'Polymarket NO minimum order is 5 shares; requested 1 share',
      pmNoMinOrderSize: 5,
      roiPct: 1,
      kalshiYesDepth: 2.25,
      pmNoDepth: 2.50,
    });
    const h = harness({
      scans: [scan({ candidates: [venueMinimumCandidate] })],
      current: [venueMinimumCandidate],
      botSettings: settings({ minRoiPct: 2 }),
      executionMode: 'paper',
    });

    await expect(h.consumer.consume(41, 'scan_api')).resolves.toMatchObject({
      state: 'criteria_rejected',
      reasonCode: 'scan_criteria_rejected',
      reason: expect.stringContaining('ROI 1.00% < min 2.00%'),
    });
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it('keeps venue-minimum scanner rejections blocked outside paper mode', async () => {
    const blocked = candidate({
      executionStatus: 'non_executable',
      executionBlocker: 'Polymarket NO minimum order is 5 shares; requested 1 share',
      pmNoMinOrderSize: 5,
      kalshiYesDepth: 2.25,
      pmNoDepth: 2.50,
    });
    const h = harness({ scans: [scan({ candidates: [blocked] })], current: [blocked], executionMode: 'live' });

    await expect(h.consumer.consume(41, 'scan_api')).resolves.toMatchObject({
      state: 'criteria_rejected',
      reasonCode: 'execution_unavailable',
    });
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it('carries refreshed executable quotes through the real execution-request handoff', async () => {
    const conditionId = `0x${'a'.repeat(64)}`;
    const current = candidate({
      pmConditionId: conditionId,
      pmYesTokenId: 'pm-yes-token',
      pmNoTokenId: 'pm-no-token',
      kalshiYesExecutableQuote: executableQuote(0.45),
      kalshiNoExecutableQuote: executableQuote(0.56),
      pmYesExecutableQuote: executableQuote(0.49),
      pmNoExecutableQuote: executableQuote(0.50),
    });
    const persisted = candidate({ pmConditionId: conditionId, pmYesTokenId: 'pm-yes-token', pmNoTokenId: 'pm-no-token' });
    const h = harness({ scans: [scan({ candidates: [persisted] })], current: [current] });
    vi.mocked(h.deps.execute).mockImplementation(async (input) => {
      expect(buildExecutionRequest(input)).toMatchObject({
        kalshiOrder: { contracts: 1, executableQuote: current.kalshiYesExecutableQuote },
        polymarketOrder: { contracts: 1, conditionId: 'pm-no-token', executableQuote: current.pmNoExecutableQuote },
      });
      return execution();
    });

    await expect(h.consumer.consume(41, 'scan_api')).resolves.toMatchObject({ state: 'placed' });
    expect(h.deps.execute).toHaveBeenCalledOnce();
  });

  it('persists disabled instead of silently returning', async () => {
    const h = harness({ botSettings: settings({ enabled: false }) });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'disabled', reasonCode: 'bot_disabled' });
    expect(h.deps.revalidate).not.toHaveBeenCalled();
    expect(h.opportunityDecisions).toEqual([expect.objectContaining({
      candidateIndex: 0,
      state: 'rejected',
      reasonCode: 'bot_disabled',
      details: expect.objectContaining({
        final: true,
        stage: 'scan_status',
        thresholds: expect.objectContaining({ minRoiPct: 2 }),
      }),
    })]);
  });

  it('persists stale when the completed scan exceeds the freshness window', async () => {
    const h = harness({ scans: [scan({ scannedAt: '2026-08-11T11:50:00.000Z' })] });
    const result = await h.consumer.consume(41, 'catch_up');
    expect(result).toMatchObject({ state: 'stale', reasonCode: 'scan_stale' });
    expect(h.opportunityDecisions).toEqual([expect.objectContaining({
      candidateIndex: 0,
      state: 'rejected',
      reasonCode: 'scan_stale',
      details: expect.objectContaining({
        final: true,
        stage: 'scan_status',
        ageMs: 610_000,
        maxScanAgeMs: 300_000,
        thresholds: expect.objectContaining({ minRoiPct: 2 }),
      }),
    })]);
  });

  it('fails closed after restart from placement_attempted without replaying venue orders or advancing the cursor', async () => {
    const h = harness({ crashAfterPlacementTransition: true });

    await expect(h.consumer.consume(41, 'scan_api')).rejects.toThrow('simulated process termination');
    expect(h.decisions.get(41)?.state).toBe('placement_attempted');
    expect(h.deps.execute).not.toHaveBeenCalled();

    h.leases.clear();
    const restarted = await h.consumer.processBacklog();

    expect(restarted).toEqual([expect.objectContaining({
      scanId: 41,
      state: 'partial_or_unhedged',
      reasonCode: 'interrupted_placement_reconciliation_required',
    })]);
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.deps.retainOpportunityForExposure).toHaveBeenCalledWith(expect.any(Object), 'paper');
    expect(h.opportunityDecisions.at(-1)).toEqual(expect.objectContaining({
      candidateIndex: 0,
      state: 'failed',
      reasonCode: 'interrupted_placement_reconciliation_required',
      details: expect.objectContaining({ final: true, possibleExposure: true }),
    }));
    expect(h.cursor()).toBe(0);
    await expect(h.consumer.processBacklog()).resolves.toEqual([]);
  });

  it('rejects malformed positive scans with no parseable candidates', async () => {
    const h = harness({ scans: [scan({ positiveArbCount: 1, candidates: [] })] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'criteria_rejected', reasonCode: 'malformed_scan' });
  });

  it('records a terminal per-opportunity audit for malformed discovered candidates', async () => {
    const h = harness({ scans: [scan({
      positiveArbCount: 1,
      candidates: [],
      rejectedCandidates: [{ candidateIndex: 0, outcome: 'Team A', strategy: 'Buy YES Kalshi + NO PM', reasonCode: 'missing_exact_ids', reason: 'Missing exact market identifiers' }],
    })] });

    await expect(h.consumer.consume(41, 'scan_api')).resolves.toMatchObject({ reasonCode: 'malformed_scan' });
    expect(h.opportunityDecisions).toEqual([expect.objectContaining({
      candidateIndex: 0,
      state: 'rejected',
      reasonCode: 'missing_exact_ids',
      details: expect.objectContaining({ final: true }),
    })]);
  });

  it('persists criteria_rejected when scan-time ROI is below active settings', async () => {
    const h = harness({ scans: [scan({ candidates: [candidate({ roiPct: 1 })] })] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'criteria_rejected', reasonCode: 'scan_criteria_rejected' });
  });

  it('persists revalidation_rejected when current ROI falls below threshold', async () => {
    const h = harness({ current: [candidate({ roiPct: 1 })] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'revalidation_rejected', reasonCode: 'current_criteria_rejected' });
  });

  it('rejects stale current quotes explicitly', async () => {
    const h = harness({ current: [candidate({ stale: true })] });
    const result = await h.consumer.consume(41, 'watcher');
    expect(result).toMatchObject({ state: 'revalidation_rejected', reasonCode: 'current_quote_stale' });
  });

  it('rejects insufficient current executable depth', async () => {
    const h = harness({ current: [candidate({
      kalshiYesDepth: 0,
      kalshiYesExecutableQuote: quoteOneShareFromTopAsk({
        price: 0.45,
        depthUsd: 0,
        tickSize: 0.01,
        minimumOrderSize: 1,
        depthTimestamp: '2026-08-11T12:00:10.000Z',
        unavailableReason: 'authoritative_empty',
      }),
    })] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result.state).toBe('revalidation_rejected');
    expect(result.reason).toContain('authoritative book is empty');
  });

  it('rejects a changed first-leg market identity', async () => {
    const h = harness({ current: [candidate({ kalshiTicker: 'KXOTHER-A' })] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'revalidation_rejected', reasonCode: 'market_identity_changed' });
  });

  it('rejects a changed second-leg market identity', async () => {
    const h = harness({ current: [candidate({ pmConditionId: 'different-condition' })] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'revalidation_rejected', reasonCode: 'market_identity_changed' });
  });

  it('rejects missing authoritative fee values for either leg', async () => {
    const h = harness({ current: [candidate({ fees: null })] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'revalidation_rejected', reasonCode: 'fees_unavailable' });
  });

  it('uses fee-adjusted refreshed ROI when fees change', async () => {
    const h = harness({ current: [candidate({ roiPct: 1, fees: { kalshiFee: 2, pmFee: 2 } })] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'revalidation_rejected', reasonCode: 'current_criteria_rejected' });
  });

  it('persists partial_or_unhedged when either placement leg is exposed', async () => {
    const h = harness({ execute: execution({ executed: false, reason: 'Second leg failed', executionResult: { success: false, unhedged: true } as never }) });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'partial_or_unhedged', reasonCode: 'partial_or_unhedged' });
  });

  it('retains the reservation when execution succeeds but position persistence fails', async () => {
    const h = harness({ execute: execution({ executed: true, positionPersisted: false, persistenceError: 'position write failed' }) });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'partial_or_unhedged', reasonCode: 'position_persistence_failed' });
    expect(result.reason).toContain('position write failed');
    expect(h.deps.retainOpportunityForExposure).toHaveBeenCalledOnce();
    expect(h.deps.releaseOpportunity).not.toHaveBeenCalled();
  });

  it('retains the reservation and stops the batch while live evidence is pending reconciliation', async () => {
    const first = candidate();
    const second = candidate({ outcome: 'B', kalshiTicker: 'KX-B', pmConditionId: 'pm-b' });
    const h = harness({
      scans: [scan({ candidates: [first, second] })],
      current: [first, second],
      execute: execution({
        executed: false,
        dryRun: false,
        reason: 'Production order acknowledgement pending authoritative fill reconciliation',
        exposureState: 'pending_reconciliation',
        positionPersisted: false,
      }),
    });

    const result = await h.consumer.consume(41, 'scan_api');

    expect(result).toMatchObject({ state: 'partial_or_unhedged', reasonCode: 'fill_reconciliation_pending' });
    expect(h.deps.execute).toHaveBeenCalledOnce();
    expect(h.deps.retainOpportunityForExposure).toHaveBeenCalledOnce();
    expect(h.deps.releaseOpportunity).toHaveBeenCalledWith(second, 'paper');
    expect(h.deps.releaseOpportunity).not.toHaveBeenCalledWith(first, 'paper');
  });

  it('fails closed as possible exposure and retains the reservation when placement throws', async () => {
    const h = harness({ execute: new Error('venue unavailable') });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'partial_or_unhedged', reasonCode: 'execution_outcome_unknown' });
    expect(result.reason).toContain('venue unavailable');
    expect(h.deps.retainOpportunityForExposure).toHaveBeenCalledOnce();
    expect(h.deps.releaseOpportunity).not.toHaveBeenCalled();
  });

  it('stops placing additional candidates after unhedged exposure', async () => {
    const first = candidate();
    const second = candidate({ outcome: 'B', kalshiTicker: 'KX-B', pmConditionId: 'pm-b' });
    const h = harness({ scans: [scan({ candidates: [first, second] })], current: [first, second] });
    vi.mocked(h.deps.execute)
      .mockResolvedValueOnce(execution({ executed: false, reason: 'Second leg failed', executionResult: { success: false, unhedged: true } as never }))
      .mockResolvedValueOnce(execution());
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result.state).toBe('partial_or_unhedged');
    expect(h.deps.execute).toHaveBeenCalledOnce();
    expect(h.deps.releaseOpportunity).toHaveBeenCalledWith(second, 'paper');
  });

  it('classifies daily limits without a silent skip', async () => {
    const h = harness({ execute: execution({ executed: false, reason: 'Daily bot trade limit reached (10/10)', executionResult: undefined }) });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'daily_limit', reasonCode: 'daily_limit' });
  });

  it('blocks production requests instead of silently recording a paper placement', async () => {
    const h = harness({ botSettings: settings({ mode: 'production' }), execute: execution({ dryRun: true }) });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'failed', reasonCode: 'production_execution_blocked' });
    expect(h.deps.reserveOpportunity).not.toHaveBeenCalled();
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it('terminally audits every discovered candidate before advancing a production-readiness-blocked scan', async () => {
    const first = candidate();
    const second = candidate({ candidateIndex: 1, outcome: 'Team B', kalshiTicker: 'KXTEST-B', pmConditionId: 'pm-condition-b' });
    const h = harness({
      botSettings: settings({ mode: 'production' }),
      scans: [scan({ candidates: [first, second] })],
    });
    h.deps.reportModeBlock = vi.fn(async () => ({
      reason: 'Production execution blocked: live credentials missing',
      alertDurable: true,
    }));

    await expect(h.consumer.consume(41, 'scan_api')).resolves.toMatchObject({
      state: 'failed',
      reasonCode: 'production_execution_blocked',
    });
    expect(h.opportunityDecisions).toEqual([
      expect.objectContaining({
        candidateIndex: 0,
        state: 'rejected',
        reasonCode: 'production_execution_blocked',
        details: expect.objectContaining({ final: true, alertDurable: true }),
      }),
      expect.objectContaining({
        candidateIndex: 1,
        state: 'rejected',
        reasonCode: 'production_execution_blocked',
        details: expect.objectContaining({ final: true, alertDurable: true }),
      }),
    ]);
    expect(h.cursor()).toBe(41);
  });

  it('binds live reservation lifecycle callbacks and execution input to live mode', async () => {
    const h = harness({ botSettings: settings({ mode: 'production' }), executionMode: 'live', execute: execution({ dryRun: false }) });
    await h.consumer.consume(41, 'scan_api');
    expect(h.deps.reserveOpportunity).toHaveBeenCalledWith(expect.any(Object), 'live');
    expect(h.deps.execute).toHaveBeenCalledWith(expect.objectContaining({ reservationMode: 'live' }));
  });

  it('records duplicate_replay and never places a duplicate delivery', async () => {
    const h = harness();
    await h.consumer.consume(41, 'scan_api');
    const replay = await h.consumer.consume(41, 'catch_up');
    expect(replay.state).toBe('duplicate_replay');
    expect(h.deps.execute).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)?.state).toBe('duplicate_replay');
  });

  it('serializes a concurrent burst for the same scan id', async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.consumer.consume(41, 'scan_api'),
      h.consumer.consume(41, 'watcher'),
    ]);
    expect([first.state, second.state].sort()).toEqual(['duplicate_replay', 'placed']);
    expect(h.deps.execute).toHaveBeenCalledTimes(1);
  });

  it('places at most once when simultaneous scans contain the same exact economic legs', async () => {
    const h = harness({ scans: [scan(), scan({ id: 42 })] });
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    vi.mocked(h.deps.execute).mockImplementation(async () => {
      await executionGate;
      return execution();
    });
    const first = h.consumer.consume(41, 'scan_api');
    const second = h.consumer.consume(42, 'watcher');
    await Promise.resolve();
    releaseExecution();
    const decisions = await Promise.all([first, second]);
    expect(h.deps.execute).toHaveBeenCalledTimes(1);
    expect(decisions.map((decision) => decision.reasonCode).sort()).toEqual(['opportunity_already_claimed', 'paper_placed']);
  });

  it('catches up every persisted positive scan and advances the durable cursor', async () => {
    const scans = [41, 42, 43].map((id) => scan({
      id,
      candidates: [candidate({ kalshiTicker: `KX-${id}`, pmConditionId: `pm-${id}`, outcome: `outcome-${id}` })],
    }));
    const h = harness({ scans });
    vi.mocked(h.deps.revalidate).mockImplementation(async (persisted) => persisted.candidates);
    const results = await h.consumer.processBacklog();
    expect(results.map((result) => result.state)).toEqual(['placed', 'placed', 'placed']);
    expect(h.deps.execute).toHaveBeenCalledTimes(3);
    expect(h.cursor()).toBe(43);
  });

  it('checkpoints a non-positive scan as not applicable before settings, candidate evaluation, or placement checks', async () => {
    const h = harness({
      scans: [scan({
        scannedAt: '2020-01-01T00:00:00.000Z',
        positiveArbCount: 0,
        candidates: [candidate()],
      })],
      botSettings: settings({ enabled: false }),
    });
    const result = await h.consumer.consume(41, 'catch_up');
    expect(result).toMatchObject({
      state: 'criteria_rejected',
      reasonCode: 'no_positive_arb',
      reason: 'No Positive Arb — BotTrader not applicable',
      attempts: 0,
      placementCount: 0,
    });
    expect(h.deps.getSettings).not.toHaveBeenCalled();
    expect(h.deps.resolveExecutionMode).not.toHaveBeenCalled();
    expect(h.deps.revalidate).not.toHaveBeenCalled();
    expect(h.deps.reserveOpportunity).not.toHaveBeenCalled();
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.opportunityDecisions).toEqual([]);
    expect(h.cursor()).toBe(41);
  });

  it('applies the positive-arb gate during catch-up without suppressing eligible scans', async () => {
    const zero = scan({ id: 41, positiveArbCount: 0, candidates: [] });
    const positive = scan({
      id: 42,
      candidates: [candidate({ kalshiTicker: 'KX-42', pmConditionId: 'pm-42' })],
    });
    const h = harness({ scans: [zero, positive] });
    vi.mocked(h.deps.revalidate).mockImplementation(async (persisted) => persisted.candidates);

    const results = await h.consumer.processBacklog();

    expect(results).toEqual([
      expect.objectContaining({ scanId: 41, reasonCode: 'no_positive_arb' }),
      expect.objectContaining({ scanId: 42, state: 'placed' }),
    ]);
    expect(h.deps.getSettings).toHaveBeenCalledTimes(1);
    expect(h.deps.revalidate).toHaveBeenCalledTimes(1);
    expect(h.deps.execute).toHaveBeenCalledTimes(1);
    expect(h.opportunityDecisions.every((decision) => decision.candidateIndex === 0)).toBe(true);
    expect(h.cursor()).toBe(42);
  });

  it('does not create candidate work when a non-positive scan is delivered twice', async () => {
    const h = harness({ scans: [scan({ positiveArbCount: 0, candidates: [] })] });

    await expect(h.consumer.consume(41, 'scan_api')).resolves.toMatchObject({ reasonCode: 'no_positive_arb' });
    await expect(h.consumer.consume(41, 'catch_up')).resolves.toMatchObject({ state: 'duplicate_replay' });

    expect(h.deps.getSettings).not.toHaveBeenCalled();
    expect(h.deps.revalidate).not.toHaveBeenCalled();
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.opportunityDecisions).toEqual([]);
  });

  it('does not advance the cursor across an unfinished completed-scan gap', async () => {
    const h = harness({ scans: [scan({ id: 41 }), scan({ id: 42 })] });
    await h.consumer.consume(42, 'scan_api');
    expect(h.cursor()).toBe(0);
    await h.consumer.consume(41, 'catch_up');
    expect(h.cursor()).toBe(42);
  });

  it('retries a disabled decision after BotTrader is re-enabled using the same decision row', async () => {
    const h = harness({ botSettings: settings({ enabled: false }) });
    expect((await h.consumer.consume(41, 'scan_api')).state).toBe('disabled');
    vi.mocked(h.deps.getSettings).mockResolvedValue(settings({ enabled: true }));
    const results = await h.consumer.processBacklog();
    expect(results).toHaveLength(1);
    expect(results[0].state).toBe('placed');
    expect(h.decisions.size).toBe(1);
  });

  it('retries a scan after temporary revalidation downtime without creating a second decision', async () => {
    const h = harness({ current: new Error('temporary upstream outage') });
    expect(await h.consumer.consume(41, 'scan_api')).toMatchObject({ state: 'failed', reasonCode: 'revalidation_failed' });
    vi.mocked(h.deps.revalidate).mockResolvedValue([candidate()]);
    const results = await h.consumer.processBacklog();
    expect(results).toHaveLength(1);
    expect(results[0].state).toBe('placed');
    expect(h.decisions.size).toBe(1);
  });

  // BOT-008 regressions
  it('shows canonical-registry-only rejection as a single focused message', async () => {
    const c = candidate({
      kalshiTicker: 'KX-UNKNOWN',
      pmConditionId: 'unknown-condition',
      propositionRelationship: null,
      roiPct: 5,
    });
    const h = harness({ scans: [scan({ candidates: [c] })], current: [c] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({
      state: 'criteria_rejected',
      reasonCode: 'scan_criteria_rejected',
      reason: expect.stringContaining('canonical proposition registry'),
    });
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it('does not execute a checked-in ledger-rejected exact tuple', async () => {
    const c = candidate({
      kalshiTicker: 'KXARREST-27JAN-THOM',
      pmConditionId: '0xbe555c50fc49ae7f1a970fbe13f226d179c192d87daa71c7ca082464b71fb8f6',
      pmNoTokenId: '27705432816847291323925622847687396001932163087018486036209592664496834211156',
      propositionRelationship: null,
      roiPct: 5,
    });
    const h = harness({ scans: [scan({ candidates: [c] })], current: [c] });

    const result = await h.consumer.consume(41, 'scan_api');

    expect(result).toMatchObject({
      state: 'criteria_rejected',
      reasonCode: 'scan_criteria_rejected',
      reason: expect.stringContaining('canonical proposition registry'),
    });
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it('reconciles multiple positive candidates each with a distinct audit trail', async () => {
    const first = candidate({ outcome: 'A', kalshiTicker: 'KX-A', pmConditionId: 'pm-a', roiPct: 3 });
    const second = candidate({ outcome: 'B', kalshiTicker: 'KX-B', pmConditionId: 'pm-b', roiPct: 1 });
    const h = harness({
      scans: [scan({ candidates: [first, second] })],
      current: [first, second],
      botSettings: settings({ minRoiPct: 4 }),
    });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result.state).toBe('criteria_rejected');
    expect(result.reason).toContain('2 candidate(s)');
    expect(h.opportunityDecisions.length).toBe(2);
    const eligibleOne = h.opportunityDecisions.find((d) => d.candidateIndex === 0);
    const ineligibleOne = h.opportunityDecisions.find((d) => d.candidateIndex === 1);
    expect(eligibleOne?.state).toBe('rejected');
    expect(ineligibleOne?.state).toBe('rejected');
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it('advances cursor after restart with a contiguous decision already present', async () => {
    const scans = [41, 42, 43].map((id) => scan({
      id,
      candidates: [candidate({ kalshiTicker: `KX-${id}`, pmConditionId: `pm-${id}`, outcome: `outcome-${id}` })],
    }));
    // Pre-decide scan 41 so the backlog starts at 42
    const h = harness({ scans });
    await h.consumer.consume(41, 'scan_api');
    expect(h.decisions.get(41)?.state).not.toBe('received');
    // Simulate restart: listBacklog should return only 42 and 43
    const backlog = await h.consumer.processBacklog();
    expect(backlog.map((b) => b.scanId)).toEqual([42, 43]);
    expect(h.cursor()).toBe(43);
  });
});
