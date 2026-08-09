import { describe, expect, it } from 'vitest';
import { rankBotCandidates } from './bot-candidate-selection';

const now = Date.parse('2026-08-09T20:00:00Z');
const market = (id: string, roiPct: number, apyPct: number, scannedAt = '2026-08-09T19:00:00Z') => ({
  id, eventTitle: id, expiryDate: '2026-09-09T00:00:00Z',
  lastScanResult: { scannedAt, allArbs: [{ roiPct, apyPct }] },
});

describe('rankBotCandidates', () => {
  it('ranks deterministically by ROI or APY with freshness and ID tie-breakers', () => {
    const markets = [market('b', 4, 20), market('a', 4, 10), market('c', 2, 90)];
    expect(rankBotCandidates(markets, 'roi', now).map(x => x.market.id)).toEqual(['a', 'b', 'c']);
    expect(rankBotCandidates(markets, 'apy', now).map(x => x.market.id)).toEqual(['c', 'b', 'a']);
  });

  it('hybrid applies both thresholds and ranks by ROI then APY without hidden weighting', () => {
    const markets = [market('roi-only', 5, 2), market('both-b', 4, 50), market('both-a', 4, 60)];
    expect(rankBotCandidates(markets, 'hybrid', now, { minRoiPct: 3, minApyPct: 10 }).map(x => x.market.id)).toEqual(['both-a', 'both-b']);
  });

  it('rejects expired, stale, missing-scan and non-positive-ROI candidates in every mode', () => {
    const stale = market('stale', 9, 999, '2026-08-07T00:00:00Z');
    const expired = { ...market('expired', 9, 999), expiryDate: '2026-08-08T00:00:00Z' };
    const missing = { id: 'missing', eventTitle: 'missing', expiryDate: null };
    const negative = market('negative', -1, 999);
    expect(rankBotCandidates([stale, expired, missing, negative], 'apy', now)).toEqual([]);
  });
});
