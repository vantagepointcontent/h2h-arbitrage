import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getBotPositionAnalytics } from '@/lib/bot-positions';
import { getPersistedCurrentPriceBatch } from '@/lib/current-price-snapshots';
import { enrichBotPositionsWithSettlementLedger } from '@/lib/bot-settlement-store';
import { GET } from './route';

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

describe('GET /api/bot-trader/positions/export outcome identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPersistedCurrentPriceBatch).mockResolvedValue(new Map());
    vi.mocked(enrichBotPositionsWithSettlementLedger).mockImplementation(async (positions) => positions as never);
  });

  it('exports sides and technical IDs but redacts unverified human outcome labels', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({ positions: [{
      id: 182,
      executionId: 101,
      status: 'open',
      kalshiTicker: 'HOUSECO8-26-R',
      pmConditionId: '0xco08',
      pmEntryTokenId: null,
      kalshiSide: 'yes',
      pmSide: 'yes',
      remainingSharesKalshi: 1,
      remainingSharesPm: 1,
      buyPriceKalshiCents: 28,
      buyPricePmCents: 29,
      totalCostCents: 98,
      entryCostStatus: 'available',
      kalshiMarketQuestion: 'Will Republican win CO-08?',
      pmMarketQuestion: 'Will the Republican Party win CO-08?',
      kalshiOutcomeLabel: 'Republican',
      pmOutcomeLabel: 'Republican',
      outcomeIdentityStatus: 'unresolved',
      propositionRelationshipState: 'same_direction_invalid',
      outcomeIdentityFailureReason: 'Exact execution token proves same-direction Republican YES exposure',
    }] } as never);

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/positions/export?mode=paper'));
    const csv = await response.text();
    const headers = parseCsvRow(csv.split('\r\n')[0]);
    const row = parseCsvRow(csv.split('\r\n').find((line) => line.startsWith('POSITION,182,'))!);

    expect(row[headers.indexOf('Kalshi Question')]).toBe('');
    expect(row[headers.indexOf('Kalshi Outcome')]).toBe('');
    expect(row[headers.indexOf('Polymarket Question')]).toBe('');
    expect(row[headers.indexOf('Polymarket Outcome')]).toBe('');
    expect(row[headers.indexOf('Kalshi Side')]).toBe('YES');
    expect(row[headers.indexOf('Polymarket Side')]).toBe('YES');
    expect(row[headers.indexOf('Kalshi Ticker')]).toBe('HOUSECO8-26-R');
    expect(row[headers.indexOf('PM Condition ID')]).toBe('0xco08');
    expect(row[headers.indexOf('Relationship Explanation')]).toBe('Exact execution token proves same-direction Republican YES exposure');
  });
});
