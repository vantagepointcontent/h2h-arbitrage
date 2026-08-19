import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getBotPositionAnalytics } from '@/lib/bot-positions';
import { getPersistedCurrentPriceBatch } from '@/lib/current-price-snapshots';
import { GET } from './route';
import { enrichBotPositionsWithSettlementLedger } from '@/lib/bot-settlement-store';

vi.mock('@/lib/bot-positions', () => ({ getBotPositionAnalytics: vi.fn() }));
vi.mock('@/lib/current-price-snapshots', () => ({
  getPersistedCurrentPriceBatch: vi.fn(),
  currentPriceSnapshotKey: (request: { platform: string; marketId: string | null; side: string; tokenId: string | null }) =>
    `${request.platform}|${request.marketId?.toLowerCase() ?? ''}|${request.side}|${request.tokenId?.toLowerCase() ?? ''}`,
}));
vi.mock('@/lib/bot-settlement-store', () => ({
  enrichBotPositionsWithSettlementLedger: vi.fn(async (positions: unknown[]) => positions),
}));

function parseCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

describe('GET /api/bot-trader/positions/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPersistedCurrentPriceBatch).mockResolvedValue(new Map());
    vi.mocked(enrichBotPositionsWithSettlementLedger).mockImplementation(async (positions) => positions as never);
  });

  it('exports mutually consistent held labels, sides, condition, and immutable token', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({ positions: [{
      id: 180, executionId: 243, status: 'open', kalshiTicker: 'KX-NY21-R',
      pmConditionId: '0xdemocratic-question', pmEntryTokenId: 'democratic-no-token',
      kalshiSide: 'yes', pmSide: 'no', remainingSharesKalshi: 1, remainingSharesPm: 1,
      buyPriceKalshiCents: 8, buyPricePmCents: 12, kalshiEntryGrossMicrocents: 8_000_000,
      pmEntryGrossMicrocents: 12_000_000, totalCostCents: 21, totalCostMicrousd: 210_000,
      settlementState: 'settled', settlementGrossProceedsCents: 100,
      settlementNetProceedsCents: 99, realizedPnlCents: 78, realizedRoiBps: 3_714,
      entryCostStatus: 'available', kalshiMarketQuestion: 'Will Republicans win NY-21?',
      pmMarketQuestion: 'Will Democrats win NY-21?', kalshiOutcomeLabel: 'Republicans',
      pmOutcomeLabel: 'Republicans', outcomeIdentityStatus: 'verified',
      propositionRelationshipState: 'verified_complementary', outcomeIdentityFailureReason: null,
      relationshipValidity: 'verified_complementary', exposureIdentityStatus: 'exact_held_legs_proven',
      exposureValuationLabel: 'Verified arbitrage', excludedFromVerifiedTotals: false,
      entryArbProfitSnapshot: {
        version: 1, status: 'available', profitMicrousd: 790_000, currency: 'USDC', monetaryUnit: 'microusd',
        matchedQuantityMicrounits: 1_000_000, guaranteedPayoutMicrousd: 1_000_000,
        grossFillsMicrocents: { kalshi: 8_000_000, polymarket: 12_000_000 },
        entryFeesMicrousd: { kalshi: 5_000, polymarket: 5_000 }, settlementFeeAssumptionMicrousd: 0,
        formula: 'guaranteed_payout_microusd-total_cost_microusd-settlement_fee_assumption_microusd',
        formulaVersion: 1, executionMode: 'paper', provenance: 'simulated_placement_fills',
        legs: { kalshi: { marketId: 'KX-NY21-R', tokenId: null, side: 'yes', outcome: 'Republicans' },
          polymarket: { marketId: '0xdemocratic-question', tokenId: 'democratic-no-token', side: 'no', outcome: 'Republicans' } },
        relationshipState: 'verified_complementary', entryRoi: { numeratorMicrousd: 790_000, denominatorMicrousd: 210_000 },
        capturedAt: '2026-08-19T11:00:00Z',
      },
    }, {
      id: 181, executionId: 244, status: 'open', kalshiTicker: 'KX-NY21-R',
      pmConditionId: '0xdemocratic-question', pmEntryTokenId: 'unproven-token',
      kalshiSide: 'yes', pmSide: 'no', remainingSharesKalshi: 1, remainingSharesPm: 1,
      buyPriceKalshiCents: 8, buyPricePmCents: 90, totalCostCents: 99,
      entryCostStatus: 'available', outcomeIdentityStatus: 'unresolved',
      outcomeIdentityFailureReason: 'Execution-time selected outcome was not persisted',
      propositionRelationshipState: 'legacy_unknown',
      entryArbProfitSnapshot: { version: 1, status: 'unavailable', reasonCode: 'exact_outcome_identity_unverified',
        reason: 'Entry Arb Profit unavailable: exact held outcome identity is not verified', executionMode: 'paper',
        provenance: 'historical_backfill', capturedAt: '2026-08-19T11:00:00Z' },
    }, {
      id: 182, executionId: 101, status: 'open', kalshiTicker: 'HOUSECO8-26-R',
      pmConditionId: '0xco08', pmEntryTokenId: null, kalshiSide: 'yes', pmSide: 'yes',
      remainingSharesKalshi: 1, remainingSharesPm: 1, buyPriceKalshiCents: 28,
      buyPricePmCents: 29, totalCostCents: 98, entryCostStatus: 'available',
      kalshiMarketQuestion: 'Will Republican win CO-08?',
      pmMarketQuestion: 'Will the Republican Party win CO-08?',
      kalshiOutcomeLabel: 'Republican', pmOutcomeLabel: 'Republican',
      outcomeIdentityStatus: 'unresolved', propositionRelationshipState: 'same_direction_invalid',
      outcomeIdentityFailureReason: 'Exact execution token proves same-direction Republican YES exposure',
      relationshipValidity: 'confirmed_invalid', exposureIdentityStatus: 'exact_held_legs_proven',
      exposureValuationLabel: 'Invalid/unverified exposure', excludedFromVerifiedTotals: true,
      legacyExposureRevision: 'legacy-revision-101',
      legacyExposureVerdict: {
        reason: 'Both exact held contracts pay on Republican YES',
        evidence: [{ source: 'executions:101', revision: 'audit-revision', capturedAt: '2026-08-19T19:30:00Z', confidence: 'exact_immutable_execution' }],
      },
    }] } as never);
    vi.mocked(getPersistedCurrentPriceBatch).mockResolvedValue(new Map([
      ['kalshi|kx-ny21-r|yes|', {
        status: 'available', priceCents: 10, priceMicrocents: 10_000_000,
        source: 'saved-market-full-scan', observedAt: '2026-08-19T12:00:00Z', ageMs: 0,
      }],
      ['polymarket|0xdemocratic-question|no|democratic-no-token', {
        status: 'available', priceCents: 9, priceMicrocents: 9_000_000,
        source: 'saved-market-full-scan', observedAt: '2026-08-19T12:01:00Z', ageMs: 0,
      }],
      ['polymarket|0xdemocratic-question|no|unproven-token', {
        status: 'available', priceCents: 91, priceMicrocents: 91_000_000,
        source: 'saved-market-full-scan', observedAt: '2026-08-19T12:02:00Z', ageMs: 0,
      }],
    ]));

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/positions/export?mode=paper'));
    const csv = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('bot-position-identities.csv');
    expect(csv).toContain('Will Democrats win NY-21?,Republicans,NO,0xdemocratic-question,democratic-no-token');
    expect(csv).toContain('Buy Price Microcents,Buy Cost Microcents');
    expect(csv).toContain('Entry Arb Profit Microusd,Entry Arb Profit Status');
    expect(csv).toContain('790000,available,,USDC,1000000,1000000,790000,210000,1,simulated_placement_fills');
    expect(csv).toContain('simulated_placement_fills,10000000,9000000,19000000,-2000000,-952');
    expect(csv).toContain('polymarket,0xdemocratic-question,NO,democratic-no-token,available,saved-market-full-scan,2026-08-19T12:01:00Z');
    const unresolvedRow = csv.split('\r\n').find((row) => row.startsWith('POSITION,181,'));
    expect(unresolvedRow).toContain('unavailable,Execution-time selected outcome was not persisted');
    expect(unresolvedRow).not.toContain('91000000');
    const totalRow = csv.split('\r\n').find((row) => row.startsWith('TOTAL,'));
    expect(totalRow).toContain('20000000,21000000,,,,,,,,,,,,,19000000,-2000000,-952');
    expect(totalRow).not.toContain('99000000');
    const parsedRows = csv.split('\r\n').map(parseCsvRow);
    const headers = parsedRows[0];
    expect(headers).toHaveLength(63);
    expect(headers).toEqual(expect.arrayContaining([
      'Relationship Validity', 'Exposure Identity', 'Exposure Valuation Class',
      'Excluded From Verified Totals', 'Legacy Exposure Reason', 'Legacy Exposure Revision', 'Legacy Exposure Evidence Provenance',
    ]));
    expect(parsedRows.every((row) => row.length === headers.length)).toBe(true);
    const parsedTotal = parsedRows.find((row) => row[0] === 'TOTAL');
    expect(parsedTotal?.[headers.indexOf('Gross Settlement Proceeds Cents')]).toBe('100');
    expect(parsedTotal?.[headers.indexOf('Net Settlement Proceeds Cents')]).toBe('99');
    expect(parsedTotal?.[headers.indexOf('Realized P/L Cents')]).toBe('78');
    const invalidRow = csv.split('\r\n').find((row) => row.startsWith('POSITION,182,'));
    expect(invalidRow).toContain('YES,0xco08,,invalid,Exact execution token proves same-direction Republican YES exposure');
    expect(parseCsvRow(invalidRow!)[headers.indexOf('Legacy Exposure Reason')]).toBe('Both exact held contracts pay on Republican YES');
    expect(parseCsvRow(invalidRow!)[headers.indexOf('Legacy Exposure Evidence Provenance')]).toBe('executions:101|audit-revision|2026-08-19T19:30:00Z|exact_immutable_execution');
  });

  it('rejects invalid filters', async () => {
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/positions/export?mode=guess'));
    expect(response.status).toBe(400);
    expect(getBotPositionAnalytics).not.toHaveBeenCalled();
  });
});
