import { describe, expect, it, vi } from 'vitest';
import {
  createBotScanConsumer,
  parseBotScanCandidate,
  type BotScanCandidate,
  type BotScanConsumerDeps,
  type BotScanDecision,
  type BotScanDecisionState,
  type PersistedBotScan,
} from './bot-scan-consumer';
import type { BotExecutionResult, BotSettings } from './bot-trader';

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
  return {
    outcome: 'Team A',
    strategy: 'Buy YES Kalshi + NO PM',
    roiPct: 5,
    apyPct: 25,
    expectedProfit: 5,
    kalshiStake: 45,
    pmStake: 50,
    kalshiTicker: 'KXTEST-A',
    pmConditionId: 'pm-condition-a',
    kalshiYesAsk: 0.45,
    kalshiNoAsk: 0.56,
    pmYesAsk: 0.49,
    pmNoAsk: 0.50,
    kalshiYesDepth: 45,
    kalshiNoDepth: 56,
    pmYesDepth: 49,
    pmNoDepth: 50,
    fees: { kalshiFee: 0.4, pmFee: 0.1 },
    expiryDate: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
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

function harness(options: {
  scans?: PersistedBotScan[];
  current?: BotScanCandidate[] | Error;
  botSettings?: BotSettings;
  execute?: BotExecutionResult | Error;
  executionMode?: 'paper' | 'live';
} = {}) {
  const scans = options.scans ?? [scan()];
  const decisions = new Map<number, BotScanDecision>();
  const events: Array<{ scanId: number; state: BotScanDecisionState; code: string }> = [];
  const leases = new Set<number>();
  const opportunityReservations = new Set<string>();
  const opportunityKey = (item: BotScanCandidate) => `${item.kalshiTicker}\0${item.pmConditionId}`;
  let cursor = 0;
  const now = new Date('2026-08-11T12:00:10.000Z');

  const deps: BotScanConsumerDeps = {
    now: () => now,
    getSettings: vi.fn(async () => options.botSettings ?? settings()),
    resolveExecutionMode: vi.fn(async () => options.executionMode ?? 'paper'),
    loadScan: vi.fn(async (id) => scans.find((item) => item.id === id) ?? null),
    listBacklog: vi.fn(async () => scans.filter((item) => {
      const state = decisions.get(item.id)?.state;
      return !state || state === 'received' || state === 'disabled'
        || (state === 'failed' && decisions.get(item.id)?.reasonCode === 'revalidation_failed');
    })),
    acquire: vi.fn(async (item, source) => {
      if (leases.has(item.id)) return null;
      const existing = decisions.get(item.id);
      if (existing && !['received', 'disabled'].includes(existing.state)
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
      row.state = 'received';
      decisions.set(item.id, row);
      events.push({ scanId: item.id, state: 'received', code: 'scan_received' });
      return row;
    }),
    transition: vi.fn(async (id, _owner, update) => {
      const row = decisions.get(id)!;
      Object.assign(row, update, { updatedAt: now.toISOString() });
      events.push({ scanId: id, state: update.state, code: update.reasonCode });
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
    advanceCursor: vi.fn(async (id) => { cursor = Math.max(cursor, id); }),
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
  };

  return { consumer: createBotScanConsumer(deps), deps, decisions, events, cursor: () => cursor, leases };
}

describe('durable BotTrader scan consumer', () => {
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

  it('records received, placement_attempted, and placed for a normal paper scan', async () => {
    const h = harness();
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result.state).toBe('placed');
    expect(h.events.map((event) => event.state)).toEqual(['received', 'placement_attempted', 'placed']);
    expect(h.deps.execute).toHaveBeenCalledTimes(1);
    expect(h.deps.reserveOpportunity).toHaveBeenCalledWith(expect.any(Object), 'paper');
    expect(h.deps.execute).toHaveBeenCalledWith(expect.objectContaining({ reservationMode: 'paper' }));
    expect(result.placementCount).toBe(1);
  });

  it('persists disabled instead of silently returning', async () => {
    const h = harness({ botSettings: settings({ enabled: false }) });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'disabled', reasonCode: 'bot_disabled' });
    expect(h.deps.revalidate).not.toHaveBeenCalled();
  });

  it('persists stale when the completed scan exceeds the freshness window', async () => {
    const h = harness({ scans: [scan({ scannedAt: '2026-08-11T11:50:00.000Z' })] });
    const result = await h.consumer.consume(41, 'catch_up');
    expect(result).toMatchObject({ state: 'stale', reasonCode: 'scan_stale' });
  });

  it('rejects malformed positive scans with no parseable candidates', async () => {
    const h = harness({ scans: [scan({ positiveArbCount: 1, candidates: [] })] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result).toMatchObject({ state: 'criteria_rejected', reasonCode: 'malformed_scan' });
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
    const h = harness({ current: [candidate({ kalshiYesDepth: 0 })] });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result.state).toBe('revalidation_rejected');
    expect(result.reason).toContain('depth');
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

  it('keeps production requests in paper mode when the execution safety guard does', async () => {
    const h = harness({ botSettings: settings({ mode: 'production' }), execute: execution({ dryRun: true }) });
    const result = await h.consumer.consume(41, 'scan_api');
    expect(result.state).toBe('placed');
    expect(result.details).toMatchObject({ dryRun: true });
    expect(h.deps.reserveOpportunity).toHaveBeenCalledWith(expect.any(Object), 'paper');
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
});
