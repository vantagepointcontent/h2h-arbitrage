import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ getExecutionByArbId: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ getExecutionByArbId: mocks.getExecutionByArbId }));
import { GET } from './route';
const ledger = { version: 1, status: 'reconciled', matchedContracts: 10, grossSpreadCents: 50, entryPrincipalCents: 950, expectedSettlementCents: 1000, exitProceedsCents: 0, totalEntryFeesCents: 12, totalExitFeesCents: 0, netPnlCents: 38, estimatedNetPnlCents: 38, feesEstimated: false, issues: [], fees: [], cashFlows: [] };

describe('GET /api/trades/[id]/execution', () => {
  beforeEach(() => {
    mocks.getExecutionByArbId.mockResolvedValue({ arbId: 'arb-ledger', marketTitle: 'Ledger market', timestamp: '2026-08-14T10:00:00Z', dryRun: false, success: true, strategy: 'cross-venue', estimatedProfit: 0.5, steps: [], result: { actualProfit: 0.38, cashLedger: ledger, steps: [] } });
  });
  it('returns the persisted cash ledger alongside the net-P&L compatibility scalar', async () => {
    const response = await GET(new NextRequest('http://localhost/api/trades/arb-ledger/execution'), { params: Promise.resolve({ id: 'arb-ledger' }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.actualProfit).toBe(0.38);
    expect(body.data.cashLedger).toEqual(ledger);
  });
});
