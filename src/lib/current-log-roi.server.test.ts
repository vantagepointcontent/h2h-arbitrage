import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolvePairFromLinks: vi.fn(),
  seedAllBooks: vi.fn(),
  computeAllLiveArbitrages: vi.fn(),
  getScanValuationInputs: vi.fn(),
  hasBook: vi.fn(),
}));

vi.mock('./pair-resolver', () => ({ resolvePairFromLinks: mocks.resolvePairFromLinks, PairResolveError: class PairResolveError extends Error {} }));
vi.mock('./book-seed', () => ({ seedAllBooks: mocks.seedAllBooks }));
vi.mock('./live-arb-engine', () => ({ computeAllLiveArbitrages: mocks.computeAllLiveArbitrages }));
vi.mock('./persistence', () => ({ getScanValuationInputs: mocks.getScanValuationInputs }));
vi.mock('./orderbook-state', () => ({ orderbookState: { hasBook: mocks.hasBook } }));

import { getCurrentLogRoiBatch, resetCurrentLogRoiStateForTests } from './current-log-roi.server';

describe('getCurrentLogRoiBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCurrentLogRoiStateForTests();
    mocks.getScanValuationInputs.mockResolvedValue([
      { id: 7, kalshiUrl: 'https://kalshi.com/markets/a/a/A', polymarketUrl: 'https://polymarket.com/event/a', totalStake: 100 },
      { id: 8, kalshiUrl: 'https://kalshi.com/markets/a/a/A', polymarketUrl: 'https://polymarket.com/event/a', totalStake: 100 },
    ]);
    mocks.resolvePairFromLinks.mockResolvedValue({ matchedOutcomes: [{}], kalshiTickers: ['A'], pmTokenIds: ['Y', 'N'], pmTokenSides: new Map(), category: 'sports' });
    mocks.seedAllBooks.mockResolvedValue(undefined);
    mocks.hasBook.mockReturnValue(true);
  });

  it('returns the highest fee-aware executable result and deduplicates repeated scans', async () => {
    mocks.computeAllLiveArbitrages.mockReturnValue([
      { strategy: 'lower', roiPct: -2, kalshiStake: 45, pmStake: 50, stale: false },
      { strategy: 'best', roiPct: 1.2345, kalshiStake: 40, pmStake: 50, stale: false },
      { strategy: 'unexecutable', roiPct: 50, kalshiStake: 0, pmStake: 0, stale: false },
    ]);

    const values = await getCurrentLogRoiBatch([7, 8]);

    expect(values).toMatchObject([
      { id: 7, status: 'available', roiPct: 1.2345, strategy: 'best' },
      { id: 8, status: 'available', roiPct: 1.2345, strategy: 'best' },
    ]);
    expect(mocks.resolvePairFromLinks).toHaveBeenCalledTimes(1);
    expect(mocks.seedAllBooks).toHaveBeenCalledTimes(1);
  });

  it('reports missing links and insufficient executable depth explicitly', async () => {
    mocks.getScanValuationInputs.mockResolvedValue([
      { id: 7, kalshiUrl: null, polymarketUrl: null, totalStake: 100 },
      { id: 8, kalshiUrl: 'https://kalshi.com/markets/a/a/A', polymarketUrl: 'https://polymarket.com/event/a', totalStake: 100 },
    ]);
    mocks.computeAllLiveArbitrages.mockReturnValue([{ strategy: 'quote only', roiPct: 4, kalshiStake: 0, pmStake: 0, stale: false }]);

    await expect(getCurrentLogRoiBatch([7, 8])).resolves.toMatchObject([
      { id: 7, status: 'missing_links' },
      { id: 8, status: 'insufficient_depth' },
    ]);
  });
});