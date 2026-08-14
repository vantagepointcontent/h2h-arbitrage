import { describe, expect, it } from 'vitest';
import { buildExecutableArb, getExecutionGateMessage, getExecutionLedgerRows } from './ExecuteArbModal';
import { walkExecutableBook } from '@/lib/executable-book';

const executableQuote = (priceMicroCents: number, tickSizeMicroCents = 1_000_000) => walkExecutableBook({
  side: 'buy',
  levels: [{ priceMicroCents, quantityMicros: 1_000_000 }],
  requestedQuantityMicros: 1_000_000,
  tickSizeMicroCents,
  minimumOrderQuantityMicros: 1_000_000,
  depthTimestamp: '2026-08-14T11:02:35.000Z',
});

const baseArb = {
  artist: 'Example outcome',
  strategy: 'Buy YES Kalshi + NO PM',
  roiPct: 3.2,
  expectedProfit: 4.8,
  kalshiStake: 42,
  pmStake: 58,
  kalshiYesAsk: 0.42,
  kalshiNoAsk: 0.58,
  pmYesAsk: 0.41,
  pmNoAsk: 0.58,
  kalshiYesAskShares: 100,
  kalshiNoAskShares: 100,
  pmYesAskShares: 100,
  pmNoAskShares: 100,
  pmYesMinOrderSize: 1,
  pmNoMinOrderSize: 1,
  pmYesTickSize: 0.01,
  pmNoTickSize: 0.01,
  stale: false,
  kalshiTicker: 'KXEXAMPLE',
  pmConditionId: 'parent-condition',
  pmYesTokenId: 'pm-yes',
  pmNoTokenId: 'pm-no',
  kalshiYesExecutableQuote: executableQuote(42_000_000),
  kalshiNoExecutableQuote: executableQuote(58_000_000),
  pmYesExecutableQuote: executableQuote(41_000_000, 100_000),
  pmNoExecutableQuote: executableQuote(58_000_000, 100_000),
};

describe('buildExecutableArb', () => {
  it('requests exactly one venue unit with walked VWAP costs and marketable limits', () => {
    const arb = buildExecutableArb({
      ...baseArb,
      kalshiStake: 50,
      pmStake: 70,
      kalshiYesAsk: 0.5,
      pmNoAsk: 0.7,
      kalshiYesExecutableQuote: executableQuote(50_000_000),
      pmNoExecutableQuote: executableQuote(70_000_000, 100_000),
      kalshiYesAskShares: 40,
      pmNoAskShares: 25,
    }, 'Example market');

    expect(arb?.shares).toBe(1);
    expect(arb?.limitingConstraint).toBe('Polymarket live depth');
    expect(arb?.kalshiOrder).toMatchObject({ outcome: 'yes', contracts: 1, price: 0.5, size: 0.5 });
    expect(arb?.polymarketOrder).toMatchObject({ outcome: 'no', contracts: 1, price: 0.7, size: 0.7, minimumOrderSize: 1 });
    expect(arb?.kalshiOrder.executableQuote).toBeDefined();
    expect(arb?.polymarketOrder.executableQuote).toBeDefined();
    expect(arb?.executionStatus).toBe('executable');
    expect(arb?.pmConditionId).toBe('parent-condition');
    // Full-book scanner profit must never leak into a top-level-depth-capped order.
    expect(arb?.expectedProfit).toBeLessThan(0);
    expect(arb?.expectedProfit).not.toBe(4.8);
    expect(arb?.roiPct).toBeLessThan(0);
  });

  it('uses the floor-eligible Kalshi quote rather than a lower synthetic ask', () => {
    const arb = buildExecutableArb({
      ...baseArb,
      kalshiYesAsk: 0.43,
      kalshiYesExecutableQuote: executableQuote(43_000_000),
      kalshiYesAskShares: 8,
      pmNoAsk: 0.56,
      pmNoExecutableQuote: executableQuote(56_000_000, 100_000),
      pmNoAskShares: 8,
      kalshiStake: 100,
      pmStake: 100,
    }, 'Example market');

    expect(arb?.kalshiOrder.price).toBe(0.43);
    expect(arb?.shares).toBe(1);
    expect(arb?.kalshiOrder.size).toBeCloseTo(0.43);
  });

  it('returns exact non-executable blockers for depth and venue minimums', () => {
    expect(buildExecutableArb({ ...baseArb, kalshiYesAskShares: 0 }, 'Example market')).toMatchObject({ executionStatus: 'non_executable', executionBlocker: expect.stringContaining('Kalshi YES') });
    expect(buildExecutableArb({ ...baseArb, pmNoAskShares: undefined }, 'Example market')).toMatchObject({ executionStatus: 'non_executable', executionBlocker: expect.stringContaining('Polymarket NO top-of-book') });
    expect(buildExecutableArb({ ...baseArb, pmNoMinOrderSize: 5 }, 'Example market')).toMatchObject({ executionStatus: 'non_executable', shares: 1, executionBlocker: 'Polymarket NO minimum order is 5 shares; requested 1 share' });
    expect(buildExecutableArb({ ...baseArb, stale: true }, 'Example market')).toBeNull();
    expect(buildExecutableArb({ ...baseArb, kalshiYesAsk: 0 }, 'Example market')).toBeNull();
    expect(buildExecutableArb({ ...baseArb, kalshiYesExecutableQuote: undefined }, 'Example market')).toBeNull();
  });
});

describe('getExecutionGateMessage', () => {
  it('keeps execution locked until gates load, but allows explicit paper bets while real trading remains locked', () => {
    expect(getExecutionGateMessage(null)).toContain('remains locked');
    expect(getExecutionGateMessage({ killSwitch: true, dryRun: true, credsReady: false })).toContain('simulated two-leg bet');
    expect(getExecutionGateMessage({ killSwitch: true, dryRun: false, credsReady: false })).toContain('Real execution is locked');
  });
});

describe('getExecutionLedgerRows', () => {
  it('labels gross spread separately from fee-inclusive net P&L and discloses estimates', () => {
    expect(getExecutionLedgerRows({
      grossSpreadCents: 50, totalEntryFeesCents: 7, totalExitFeesCents: 3,
      netPnlCents: 40, feesEstimated: true, status: 'reconciled',
    })).toEqual([
      { label: 'Actual gross spread', value: '$0.50' },
      { label: 'Entry fees (estimated)', value: '-$0.07' },
      { label: 'Exit fees (estimated)', value: '-$0.03' },
      { label: 'Actual net P&L', value: '$0.40' },
    ]);
  });

  it('withholds net P&L while rollback cash remains unreconciled', () => {
    expect(getExecutionLedgerRows({
      grossSpreadCents: 0, totalEntryFeesCents: 7, totalExitFeesCents: 0,
      netPnlCents: null, feesEstimated: false, status: 'reconciliation-required',
    }).at(-1)).toEqual({ label: 'Actual net P&L', value: 'Reconciliation required' });
  });

  it('labels charged entry fees separately from estimated exit fees', () => {
    const rows = getExecutionLedgerRows({
      grossSpreadCents: 0, totalEntryFeesCents: 7, totalExitFeesCents: 3,
      netPnlCents: null, feesEstimated: true, status: 'reconciliation-required',
      fees: [
        { stage: 'entry', source: 'charged' },
        { stage: 'exit', source: 'estimated' },
      ],
    });
    expect(rows[1].label).toBe('Entry fees (charged)');
    expect(rows[2].label).toBe('Exit fees (estimated)');
  });

  it('discloses estimated net P&L without promoting it to reconciled actual', () => {
    const rows = getExecutionLedgerRows({
      grossSpreadCents: 50, totalEntryFeesCents: 7, totalExitFeesCents: 0,
      netPnlCents: null, estimatedNetPnlCents: 43, feesEstimated: true,
      status: 'reconciliation-required',
    });
    expect(rows).toContainEqual({ label: 'Estimated net P&L (not actual)', value: '$0.43' });
    expect(rows.at(-1)).toEqual({ label: 'Actual net P&L', value: 'Reconciliation required' });
  });
});
