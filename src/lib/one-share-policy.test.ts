import { describe, expect, it } from 'vitest';
import { calculateAllArbitrages, calculateArbitrageMax, type UnifiedOutcome } from './matcher';
import { isPriceAlignedToTick } from './venue-constraints';

const kalshi = {
  ticker: 'KX-ONE', yesBid: 0.39, yesAsk: 0.4, noBid: 0.59, noAsk: 0.6,
  lastPrice: 0.4, yesAskDepth: '400', noAskDepth: '600',
};
const polymarket = {
  marketId: 'pm-one', conditionId: 'condition-one', yesTokenId: 'yes-one', noTokenId: 'no-one',
  yesPrice: 0.55, noPrice: 0.5, bestBid: 0.5, bestAsk: 0.55, lastTradePrice: 0.55,
  askDepth: 550, noAskDepth: 500, yesMinOrderSize: 1, noMinOrderSize: 1, yesTickSize: 0.01, noTickSize: 0.01,
  binaryVerified: true,
};

function outcome(artist: string, ticker: string, conditionId: string): UnifiedOutcome {
  return {
    artist,
    kalshi: { ...kalshi, ticker },
    polymarket: { ...polymarket, marketId: conditionId, conditionId },
    arbitrage: {
      strategy: 'No arb', arbType: null, kalshiStake: 0, pmStake: 0,
      expectedProfit: 0, roiPct: 0, maxCapital: 0,
      buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0,
    },
    source: 'auto',
  };
}

describe('canonical one-share opportunity policy', () => {
  it('validates sub-cent ticks with exact decimal divisibility', () => {
    expect(isPriceAlignedToTick(0.425, 0.001)).toBe(true);
    expect(isPriceAlignedToTick(0.4255, 0.001)).toBe(false);
  });

  it('prices a direct strategy at exactly one contract on each venue regardless of depth/capital', () => {
    const result = calculateArbitrageMax(kalshi, polymarket, 400, 600, 550, 500, 'politics', 10_000);

    expect(result.requestedContracts).toBe(1);
    expect(result.executionStatus).toBe('executable');
    expect(result.maxCapital).toBe(1);
    expect(result.kalshiStake).toBe(0.4);
    expect(result.pmStake).toBe(0.5);
  });

  it('fails closed when top-of-book depth cannot fill one share', () => {
    const result = calculateArbitrageMax(kalshi, polymarket, 0.39, 600, 550, 500, 'politics');

    expect(result.requestedContracts).toBe(1);
    expect(result.executionStatus).toBe('non_executable');
    expect(result.executionBlocker).toBe('Kalshi YES top-of-book depth 0.39 USD cannot fill requested 1 contract at 0.4 USD');
    expect(result.maxCapital).toBe(0);
  });

  it('rejects a PM venue minimum of five without increasing the requested quantity', () => {
    const result = calculateArbitrageMax(kalshi, { ...polymarket, noMinOrderSize: 5 }, 400, 600, 550, 500, 'politics', 10_000);

    expect(result.requestedContracts).toBe(1);
    expect(result.executionStatus).toBe('non_executable');
    expect(result.executionBlocker).toBe('Polymarket NO minimum order is 5 shares; requested 1 share');
    expect(result.maxCapital).toBe(0);
  });

  it('requires explicit mutual-exclusivity and exhaustiveness evidence for cross outcome', () => {
    const a = outcome('A', 'KX-A', 'pm-a');
    const b = outcome('B', 'KX-B', 'pm-b');
    a.kalshi!.yesAsk = 0.3;
    b.polymarket!.bestAsk = 0.3;
    b.polymarket!.yesPrice = 0.3;

    expect(calculateAllArbitrages([a, b], 'politics').some((row) => row.arbitrage.arbType === 'cross')).toBe(false);
    expect(calculateAllArbitrages([a, b], 'politics', 1, {
      mutuallyExclusive: true,
      exhaustive: true,
    }).some((row) => row.arbitrage.arbType === 'cross')).toBe(true);
  });

  it('prices internal complementary legs at one contract each', () => {
    const row = outcome('A', 'KX-A', 'pm-a');
    row.kalshi = { ...row.kalshi!, yesAsk: 0.3, noAsk: 0.3, yesAskDepth: '30', noAskDepth: '30' };
    const result = calculateAllArbitrages([row], 'politics')[0].arbitrage;

    expect(result.arbType).toBe('internal');
    expect(result.requestedContracts).toBe(1);
    expect(result.maxCapital).toBe(1);
    expect(result.kalshiStake).toBe(0.6);
  });
});