import { describe, expect, it, vi } from 'vitest';
import {
  buildOpportunityKey,
  decideCompletedScanOpportunity,
  type CompletedScanOpportunity,
  type RevalidatedOpportunity,
} from './bot-scan-consumer';

function completed(overrides: Partial<CompletedScanOpportunity> = {}): CompletedScanOpportunity {
  return {
    scanId: 101,
    marketId: 'pair-1',
    marketTitle: 'Test market',
    scannedAt: '2026-08-11T12:00:00.000Z',
    outcome: 'Team A',
    strategy: 'Buy YES Kalshi + NO PM',
    roiBps: 600,
    kalshiTicker: 'KX-TEAM-A',
    pmConditionId: 'pm-team-a',
    ...overrides,
  };
}

function live(overrides: Partial<RevalidatedOpportunity> = {}): RevalidatedOpportunity {
  return {
    input: {
      pairId: 'pair-1', marketTitle: 'Test market', outcome: 'Team A',
      strategy: 'Buy YES Kalshi + NO PM', roiPct: 6, expectedProfit: 0.06,
      kalshiStake: 0.4, pmStake: 0.54, kalshiTicker: 'KX-TEAM-A',
      pmConditionId: 'pm-team-a', kalshiYesAsk: 0.4, pmNoAsk: 0.54,
      kalshiYesDepth: 40, pmNoDepth: 54,
    },
    roiBps: 600,
    feeAuthority: { kalshiFeeCents: 1, polymarketFeeCents: 1 },
    quoteObservedAt: '2026-08-11T12:00:01.000Z',
    ...overrides,
  };
}

const settings = { enabled: true, mode: 'paper' as const, minRoiBps: 500, maxTradesPerDay: 10 };

it('builds a stable per-scan/outcome idempotency key', () => {
  expect(buildOpportunityKey(completed())).toBe(buildOpportunityKey(completed()));
  expect(buildOpportunityKey(completed({ scanId: 102 }))).not.toBe(buildOpportunityKey(completed()));
});

describe('decideCompletedScanOpportunity', () => {
  it('places a normal eligible opportunity in paper mode', async () => {
    const execute = vi.fn().mockResolvedValue({ executed: true, dryRun: true, reason: 'paper placed' });
    const result = await decideCompletedScanOpportunity(completed(), settings, async () => live(), execute);
    expect(result.state).toBe('placed');
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['disabled bot', { enabled: false }, 'criteria_rejected', 'BOT_DISABLED'],
    ['ROI below threshold', {}, 'criteria_rejected', 'ROI_BELOW_THRESHOLD'],
    ['production requested', { mode: 'production' }, 'criteria_rejected', 'PRODUCTION_NOT_APPROVED'],
    ['daily limit', { maxTradesPerDay: 0 }, 'criteria_rejected', 'DAILY_LIMIT_REACHED'],
  ] as const)('%s persists an explicit criteria reason', async (_name, settingPatch, state, code) => {
    const opportunity = code === 'ROI_BELOW_THRESHOLD' ? completed({ roiBps: 499 }) : completed();
    const result = await decideCompletedScanOpportunity(opportunity, { ...settings, ...settingPatch }, async () => live(), vi.fn());
    expect(result).toMatchObject({ state, reasonCode: code });
    expect(result.reason).toBeTruthy();
  });

  it.each([
    ['stale quote', { rejection: { code: 'STALE_QUOTE', reason: 'quote is stale' } }],
    ['insufficient depth', { rejection: { code: 'INSUFFICIENT_DEPTH', reason: 'second leg lacks depth' } }],
    ['first leg changed', { rejection: { code: 'FIRST_LEG_CHANGED', reason: 'Kalshi ask changed' } }],
    ['second leg changed', { rejection: { code: 'SECOND_LEG_CHANGED', reason: 'Polymarket ask changed' } }],
    ['fee change', { rejection: { code: 'FEE_CHANGED', reason: 'fees changed' } }],
    ['malformed scan', { rejection: { code: 'MALFORMED_SCAN', reason: 'scan payload malformed' } }],
  ] as const)('%s is a machine-readable revalidation rejection', async (_name, revalidated) => {
    const result = await decideCompletedScanOpportunity(completed(), settings, async () => revalidated, vi.fn());
    expect(result.state).toBe('revalidation_rejected');
    expect(result.reasonCode).toBe(revalidated.rejection.code);
    expect(result.reason).toBe(revalidated.rejection.reason);
  });

  it('rejects exact market/outcome identity mismatch', async () => {
    const result = await decideCompletedScanOpportunity(completed(), settings, async () => live({ input: { ...live().input, outcome: 'Team B' } }), vi.fn());
    expect(result).toMatchObject({ state: 'revalidation_rejected', reasonCode: 'IDENTITY_MISMATCH' });
  });

  it('rejects malformed fee authority', async () => {
    const result = await decideCompletedScanOpportunity(completed(), settings, async () => live({ feeAuthority: { kalshiFeeCents: -1, polymarketFeeCents: 1 } }), vi.fn());
    expect(result).toMatchObject({ state: 'revalidation_rejected', reasonCode: 'MALFORMED_FEES' });
  });

  it('rejects when current ROI falls below threshold', async () => {
    const result = await decideCompletedScanOpportunity(completed(), settings, async () => live({ roiBps: 499 }), vi.fn());
    expect(result).toMatchObject({ state: 'revalidation_rejected', reasonCode: 'ROI_FELL_BELOW_THRESHOLD' });
  });

  it.each([
    ['partial/unhedged', { executed: false, dryRun: true, reason: 'partial', executionResult: { unhedged: true } }, 'partial_unhedged', 'PARTIAL_UNHEDGED'],
    ['placement failure', { executed: false, dryRun: true, reason: 'venue rejected' }, 'failed', 'PLACEMENT_FAILED'],
  ] as const)('%s receives an explicit terminal decision', async (_name, execution, state, reasonCode) => {
    const result = await decideCompletedScanOpportunity(completed(), settings, async () => live(), vi.fn().mockResolvedValue(execution));
    expect(result).toMatchObject({ state, reasonCode });
  });

  it('never permits production execution', async () => {
    const execute = vi.fn();
    await decideCompletedScanOpportunity(completed(), { ...settings, mode: 'production' }, async () => live(), execute);
    expect(execute).not.toHaveBeenCalled();
  });
});
