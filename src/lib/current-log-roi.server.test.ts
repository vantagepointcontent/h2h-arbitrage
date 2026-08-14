import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolvePairFromLinks: vi.fn(),
  seedAllBooks: vi.fn(),
  computeAllLiveArbitrages: vi.fn(),
  computeCapturedLiveArbitrages: vi.fn(),
  getScanValuationInputs: vi.fn(),
  hasBook: vi.fn(),
}));

vi.mock('./pair-resolver', () => ({ resolvePairFromLinks: mocks.resolvePairFromLinks, PairResolveError: class PairResolveError extends Error {} }));
vi.mock('./book-seed', () => ({ seedAllBooks: mocks.seedAllBooks }));
vi.mock('./live-arb-engine', () => ({
  computeAllLiveArbitrages: mocks.computeAllLiveArbitrages,
  computeCapturedLiveArbitrages: mocks.computeCapturedLiveArbitrages,
}));
vi.mock('./persistence', () => ({ getScanValuationInputs: mocks.getScanValuationInputs }));
vi.mock('./orderbook-state', () => ({ orderbookState: { hasBook: mocks.hasBook } }));

import { getCurrentLogRoiBatch, resetCurrentLogRoiStateForTests } from './current-log-roi.server';

describe('getCurrentLogRoiBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCurrentLogRoiStateForTests();
    mocks.getScanValuationInputs.mockResolvedValue([
      { id: 7, kalshiUrl: 'https://kalshi.com/markets/a/a/A', polymarketUrl: 'https://polymarket.com/event/a', scanCapital: 100, candidates: [{ kalshiTicker: 'A', pmConditionId: 'C', arbType: 'direct', strategy: 'best' }] },
      { id: 8, kalshiUrl: 'https://kalshi.com/markets/a/a/A', polymarketUrl: 'https://polymarket.com/event/a', scanCapital: 100, candidates: [{ kalshiTicker: 'A', pmConditionId: 'C', arbType: 'direct', strategy: 'best' }] },
    ]);
    mocks.resolvePairFromLinks.mockResolvedValue({ matchedOutcomes: [{}], kalshiTickers: ['A'], pmTokenIds: ['Y', 'N'], pmTokenSides: new Map(), category: 'sports' });
    mocks.seedAllBooks.mockResolvedValue(undefined);
    mocks.hasBook.mockReturnValue(true);
    mocks.computeCapturedLiveArbitrages.mockImplementation((_outcomes, _capital, _category, candidates) => (
      mocks.computeAllLiveArbitrages().filter((result: { strategy: string }) => candidates.some((candidate: { strategy: string }) => (
        candidate.strategy.replace(/Polymarket/g, 'PM') === result.strategy.replace(/Polymarket/g, 'PM')
      )))
    ));
  });

  it('returns the highest fee-aware executable result and deduplicates repeated scans', async () => {
    mocks.computeAllLiveArbitrages.mockReturnValue([
      { strategy: 'lower', arbType: 'direct', kalshiTicker: 'B', pmConditionId: 'D', roiPct: -2, kalshiStake: 45, pmStake: 50, stale: false },
      { strategy: 'best', arbType: 'direct', kalshiTicker: 'A', pmConditionId: 'C', roiPct: 1.2345, kalshiStake: 40, pmStake: 50, stale: false },
      { strategy: 'unexecutable', arbType: 'direct', kalshiTicker: 'A', pmConditionId: 'C', roiPct: 50, kalshiStake: 0, pmStake: 0, stale: false },
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
      { id: 7, kalshiUrl: null, polymarketUrl: null, scanCapital: 100, candidates: [] },
      { id: 8, kalshiUrl: 'https://kalshi.com/markets/a/a/A', polymarketUrl: 'https://polymarket.com/event/a', scanCapital: 100, candidates: [{ kalshiTicker: 'A', pmConditionId: 'C', arbType: 'direct', strategy: 'quote only' }] },
    ]);
    mocks.computeAllLiveArbitrages.mockReturnValue([{ strategy: 'quote only', arbType: 'direct', kalshiTicker: 'A', pmConditionId: 'C', roiPct: 4, kalshiStake: 0, pmStake: 0, stale: false }]);

    await expect(getCurrentLogRoiBatch([7, 8])).resolves.toMatchObject([
      { id: 7, status: 'missing_links' },
      { id: 8, status: 'insufficient_depth' },
    ]);
  });

  it('keeps different captured strategies separate and uses original scan capital', async () => {
    mocks.getScanValuationInputs.mockResolvedValue([
      { id: 7, kalshiUrl: 'https://kalshi.com/markets/a/a/A', polymarketUrl: 'https://polymarket.com/event/a', scanCapital: 100, candidates: [{ kalshiTicker: 'A', pmConditionId: 'C', arbType: 'direct', strategy: 'direct-strategy' }] },
      { id: 8, kalshiUrl: 'https://kalshi.com/markets/a/a/A', polymarketUrl: 'https://polymarket.com/event/a', scanCapital: 100, candidates: [{ kalshiTicker: 'A', pmConditionId: 'C', arbType: 'cross', strategy: 'cross-strategy' }] },
    ]);
    mocks.computeAllLiveArbitrages.mockReturnValue([
      { strategy: 'direct-strategy', arbType: 'direct', kalshiTicker: 'A', pmConditionId: 'C', roiPct: 1, kalshiStake: 40, pmStake: 50, stale: false },
      { strategy: 'cross-strategy', arbType: 'cross', kalshiTicker: 'A', pmConditionId: 'C', roiPct: 2, kalshiStake: 40, pmStake: 50, stale: false },
    ]);

    const values = await getCurrentLogRoiBatch([7, 8]);

    expect(values).toMatchObject([{ id: 7, roiPct: 1 }, { id: 8, roiPct: 2 }]);
    expect(mocks.resolvePairFromLinks).toHaveBeenCalledTimes(2);
    expect(mocks.resolvePairFromLinks).toHaveBeenNthCalledWith(1, expect.any(Array), 100);
    expect(mocks.computeCapturedLiveArbitrages).toHaveBeenNthCalledWith(1, expect.any(Array), 100, 'sports', expect.any(Array));
  });

  it('selects a fresh eligible result despite unrelated stale or missing books', async () => {
    mocks.getScanValuationInputs.mockResolvedValue([{
      id: 7,
      kalshiUrl: 'https://kalshi.com/markets/a/a/A',
      polymarketUrl: 'https://polymarket.com/event/a',
      scanCapital: 100,
      candidates: [
        { kalshiTicker: 'A', pmConditionId: 'C', arbType: 'direct', strategy: 'best' },
        { kalshiTicker: 'B', pmConditionId: 'D', arbType: 'direct', strategy: 'other' },
      ],
    }]);
    mocks.computeAllLiveArbitrages.mockReturnValue([
      { strategy: 'best', arbType: 'direct', kalshiTicker: 'A', pmConditionId: 'C', roiPct: 3, kalshiStake: 40, pmStake: 50, stale: false },
      { strategy: 'other', arbType: 'direct', kalshiTicker: 'B', pmConditionId: 'D', roiPct: 0, kalshiStake: 0, pmStake: 0, stale: true },
    ]);
    mocks.hasBook.mockImplementation((id: string) => id !== 'Y');

    await expect(getCurrentLogRoiBatch([7])).resolves.toMatchObject([
      { id: 7, status: 'available', roiPct: 3 },
    ]);
  });

  it('normalizes equivalent captured Polymarket and live PM strategy labels', async () => {
    mocks.getScanValuationInputs.mockResolvedValue([{
      id: 7,
      kalshiUrl: 'https://kalshi.com/markets/a/a/A',
      polymarketUrl: 'https://polymarket.com/event/a',
      scanCapital: 100,
      candidates: [{ kalshiTicker: 'A', pmConditionId: 'C', arbType: 'cross', strategy: 'Buy YES both sides: Kalshi A + Polymarket B' }],
    }]);
    mocks.computeAllLiveArbitrages.mockReturnValue([
      { strategy: 'Buy YES both sides: Kalshi A + PM B', arbType: 'cross', kalshiTicker: 'A', pmConditionId: 'C', roiPct: 3, kalshiStake: 40, pmStake: 50, stale: false },
    ]);

    await expect(getCurrentLogRoiBatch([7])).resolves.toMatchObject([{ id: 7, status: 'available', roiPct: 3 }]);
  });

  it('uses exact captured-strategy evaluation instead of filtering the current winner', async () => {
    mocks.getScanValuationInputs.mockResolvedValue([{
      id: 7,
      kalshiUrl: 'https://kalshi.com/markets/a/a/A',
      polymarketUrl: 'https://polymarket.com/event/a',
      scanCapital: 100,
      candidates: [{ kalshiTicker: 'A', pmConditionId: 'C', arbType: 'direct', strategy: 'Buy YES PM + NO Kalshi' }],
    }]);
    mocks.computeAllLiveArbitrages.mockReturnValue([
      { strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct', kalshiTicker: 'A', pmConditionId: 'C', roiPct: 12.0825, kalshiStake: 40, pmStake: 45, stale: false },
    ]);
    mocks.computeCapturedLiveArbitrages.mockReturnValue([
      { strategy: 'Buy YES PM + NO Kalshi', arbType: 'direct', kalshiTicker: 'A', pmConditionId: 'C', roiPct: -17.9175, kalshiStake: 60, pmStake: 55, stale: false },
    ]);

    await expect(getCurrentLogRoiBatch([7])).resolves.toMatchObject([{
      id: 7,
      status: 'available',
      strategy: 'Buy YES PM + NO Kalshi',
      roiPct: -17.9175,
    }]);
    expect(mocks.computeCapturedLiveArbitrages).toHaveBeenCalledWith(
      expect.any(Array),
      100,
      'sports',
      expect.arrayContaining([expect.objectContaining({ strategy: 'Buy YES PM + NO Kalshi' })]),
    );
  });

  it('limits concurrent unique pair resolutions', async () => {
    let active = 0;
    let maxActive = 0;

    mocks.getScanValuationInputs.mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      kalshiUrl: `https://kalshi.com/markets/a/a/A${index}`,
      polymarketUrl: `https://polymarket.com/event/a${index}`,
      scanCapital: 100,
      candidates: [{ kalshiTicker: `A${index}`, pmConditionId: `C${index}`, arbType: 'direct', strategy: 'best' }],
    })));
    mocks.resolvePairFromLinks.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { matchedOutcomes: [{}], kalshiTickers: ['A'], pmTokenIds: ['Y', 'N'], pmTokenSides: new Map(), category: 'sports' };
    });
    mocks.computeAllLiveArbitrages.mockReturnValue([]);

    await getCurrentLogRoiBatch(Array.from({ length: 8 }, (_, index) => index + 1));

    expect(maxActive).toBeLessThanOrEqual(3);
  });
});