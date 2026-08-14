import { describe, expect, it } from 'vitest';
import {
  reconcileExecutionCashLedger,
  type ExecutionLedgerInput,
} from './execution-cash-ledger';

function matchedInput(overrides: Partial<ExecutionLedgerInput> = {}): ExecutionLedgerInput {
  return {
    kalshiEntry: { venue: 'kalshi', filledContracts: 10, filledPrice: 0.45, chargedFeeCents: 7 },
    polymarketEntry: { venue: 'polymarket', filledContracts: 10, filledPrice: 0.5, chargedFeeCents: 5 },
    closes: [],
    unhedged: false,
    ...overrides,
  };
}

describe('reconcileExecutionCashLedger', () => {
  it('separates matched-fill gross spread from net P&L and prefers charged entry fees', () => {
    const ledger = reconcileExecutionCashLedger(matchedInput());
    expect(ledger).toMatchObject({
      version: 1, status: 'reconciled', matchedContracts: 10, grossSpreadCents: 50,
      totalEntryFeesCents: 12, totalExitFeesCents: 0, netPnlCents: 38,
    });
    expect(ledger.fees).toEqual([
      expect.objectContaining({ venue: 'kalshi', stage: 'entry', amountCents: 7, source: 'charged' }),
      expect.objectContaining({ venue: 'polymarket', stage: 'entry', amountCents: 5, source: 'charged' }),
    ]);
  });

  it('reconciles matched partial fills using the filled quantity', () => {
    const ledger = reconcileExecutionCashLedger(matchedInput({
      kalshiEntry: { venue: 'kalshi', filledContracts: 4, filledPrice: 0.45, chargedFeeCents: 3 },
      polymarketEntry: { venue: 'polymarket', filledContracts: 4, filledPrice: 0.5, chargedFeeCents: 2 },
    }));
    expect(ledger).toMatchObject({ status: 'reconciled', matchedContracts: 4, grossSpreadCents: 20, netPnlCents: 15 });
  });

  it('reconciles a successful one-leg rollback from entry cash, close proceeds, and both fees', () => {
    const ledger = reconcileExecutionCashLedger({
      kalshiEntry: { venue: 'kalshi', filledContracts: 10, filledPrice: 0.45, chargedFeeCents: 7 },
      polymarketEntry: { venue: 'polymarket', filledContracts: 0 },
      closes: [{ venue: 'kalshi', requestedContracts: 10, filledContracts: 10, filledPrice: 0.44, chargedFeeCents: 6, complete: true, priceSource: 'venue' }],
      unhedged: false,
    });
    expect(ledger).toMatchObject({
      status: 'reconciled', matchedContracts: 0, grossSpreadCents: 0, entryPrincipalCents: 450,
      exitProceedsCents: 440, totalEntryFeesCents: 7, totalExitFeesCents: 6, netPnlCents: -23,
    });
  });

  it('withholds net P&L when a rollback fails and exposure remains', () => {
    const ledger = reconcileExecutionCashLedger({
      kalshiEntry: { venue: 'kalshi', filledContracts: 10, filledPrice: 0.45, chargedFeeCents: 7 },
      polymarketEntry: { venue: 'polymarket', filledContracts: 0 },
      closes: [{ venue: 'kalshi', requestedContracts: 10, filledContracts: 3, filledPrice: 0.44, chargedFeeCents: 2, complete: false, priceSource: 'venue' }],
      unhedged: true,
    });
    expect(ledger.status).toBe('reconciliation-required');
    expect(ledger.netPnlCents).toBeNull();
    expect(ledger.exitProceedsCents).toBe(132);
  });

  it('keeps the matched core and reconciles a successful excess close for mismatched fills', () => {
    const ledger = reconcileExecutionCashLedger({
      kalshiEntry: { venue: 'kalshi', filledContracts: 10, filledPrice: 0.45, chargedFeeCents: 7 },
      polymarketEntry: { venue: 'polymarket', filledContracts: 8, filledPrice: 0.5, chargedFeeCents: 4 },
      closes: [{ venue: 'kalshi', requestedContracts: 2, filledContracts: 2, filledPrice: 0.44, chargedFeeCents: 1, complete: true, priceSource: 'venue' }],
      unhedged: false,
    });
    expect(ledger).toMatchObject({ status: 'reconciled', matchedContracts: 8, grossSpreadCents: 40, expectedSettlementCents: 800, exitProceedsCents: 88, netPnlCents: 26 });
  });

  it('discloses estimated entry and exit fees when charged amounts are absent', () => {
    const ledger = reconcileExecutionCashLedger({
      kalshiEntry: { venue: 'kalshi', filledContracts: 10, filledPrice: 0.45 },
      polymarketEntry: { venue: 'polymarket', filledContracts: 0 },
      closes: [{ venue: 'kalshi', requestedContracts: 10, filledContracts: 10, filledPrice: 0.44, complete: true, priceSource: 'estimated' }],
      unhedged: false,
    });
    expect(ledger.feesEstimated).toBe(true);
    expect(ledger.fees).toEqual([
      expect.objectContaining({ venue: 'kalshi', stage: 'entry', source: 'estimated', estimatedRateBps: 700 }),
      expect.objectContaining({ venue: 'kalshi', stage: 'exit', source: 'estimated', estimatedRateBps: 700 }),
    ]);
    expect(ledger.cashFlows).toContainEqual(expect.objectContaining({ kind: 'exit-proceeds', source: 'estimated', amountCents: 440 }));
    expect(ledger.status).toBe('reconciliation-required');
    expect(ledger.netPnlCents).toBeNull();
    expect(ledger.estimatedNetPnlCents).toBeTypeOf('number');
    expect(ledger.issues).toContain('estimated-fees');
    expect(ledger.issues).toContain('estimated-exit-proceeds');
  });

  it('keeps positive fills with missing prices explicitly unknown instead of fabricating profit', () => {
    const ledger = reconcileExecutionCashLedger({
      kalshiEntry: { venue: 'kalshi', filledContracts: 10, chargedFeeCents: 7 },
      polymarketEntry: { venue: 'polymarket', filledContracts: 10, filledPrice: 0.5, chargedFeeCents: 5 },
      closes: [],
      unhedged: false,
    });

    expect(ledger.status).toBe('reconciliation-required');
    expect(ledger.issues).toContain('missing-entry-price:kalshi');
    expect(ledger.entryPrincipalCents).toBeNull();
    expect(ledger.grossSpreadCents).toBeNull();
    expect(ledger.netPnlCents).toBeNull();
    expect(ledger.estimatedNetPnlCents).toBeNull();
  });

  it('preserves unknown entry fill quantity as reconciliation-required', () => {
    const ledger = reconcileExecutionCashLedger({
      kalshiEntry: { venue: 'kalshi', filledContracts: undefined },
      polymarketEntry: { venue: 'polymarket', filledContracts: 0 },
      closes: [],
      unhedged: false,
    });
    expect(ledger.status).toBe('reconciliation-required');
    expect(ledger.issues).toContain('unknown-entry-quantity:kalshi');
    expect(ledger.netPnlCents).toBeNull();
  });

  it('reproduces actual net P&L exactly from persisted cash flows and charged fees', () => {
    const ledger = reconcileExecutionCashLedger(matchedInput());
    const cash = ledger.cashFlows.reduce((sum, flow) => sum + flow.amountCents, 0);
    const fees = ledger.fees.reduce((sum, fee) => sum + fee.amountCents, 0);
    expect(ledger.netPnlCents).toBe(cash - fees);
  });

  it('fuzzes floats, nulls, and negative values without fractional cents or false reconciliation', () => {
    let seed = 0x70573da4;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
    const arbitrary = (): number | null => random() < 0.12 ? null : (random() * 2000 - 1000) + random();
    for (let index = 0; index < 1_000; index += 1) {
      const ledger = reconcileExecutionCashLedger({
        kalshiEntry: { venue: 'kalshi', filledContracts: arbitrary(), filledPrice: arbitrary(), chargedFeeCents: arbitrary() },
        polymarketEntry: { venue: 'polymarket', filledContracts: arbitrary(), filledPrice: arbitrary(), chargedFeeCents: arbitrary() },
        closes: [{ venue: 'kalshi', requestedContracts: arbitrary() ?? 0, filledContracts: arbitrary(), filledPrice: arbitrary(), chargedFeeCents: arbitrary(), complete: random() > 0.5, priceSource: random() > 0.5 ? 'venue' : 'estimated' }],
        unhedged: random() > 0.75,
      });
      for (const value of [ledger.grossSpreadCents, ledger.entryPrincipalCents, ledger.expectedSettlementCents, ledger.exitProceedsCents, ledger.totalEntryFeesCents, ledger.totalExitFeesCents, ledger.netPnlCents, ledger.estimatedNetPnlCents]) {
        expect(value == null || Number.isSafeInteger(value)).toBe(true);
      }
      expect(ledger.cashFlows.every((flow) => Number.isSafeInteger(flow.amountCents))).toBe(true);
      expect(ledger.fees.every((fee) => Number.isSafeInteger(fee.amountCents) && fee.amountCents >= 0)).toBe(true);
      if (ledger.status === 'reconciled') {
        expect(ledger.issues).toEqual([]);
        const cash = ledger.cashFlows.reduce((sum, flow) => sum + flow.amountCents, 0);
        const fees = ledger.fees.reduce((sum, fee) => sum + fee.amountCents, 0);
        expect(ledger.netPnlCents).toBe(cash - fees);
      }
    }
  });
});
