// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OverviewPanel } from './OverviewPanel';
import type { SavedMarket } from '@/app/lib/page-shared';

vi.mock('./ApyTooltip', () => ({
  ApyHeaderInfo: () => null,
  ApyValueTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  buildMarketTooltip: () => '',
  getDaysToExpiry: () => 1,
}));
vi.mock('./ArbLegBreakdown', () => ({
  CompactStrategyDisplay: ({ strategy }: { strategy: string }) => <span>{strategy}</span>,
}));

const market = (id: string, eventTitle: string, category?: string): SavedMarket => ({
  id,
  eventTitle,
  category,
  kalshiUrl: '',
  polymarketUrl: '',
  createdAt: '2026-07-27T00:00:00.000Z',
  expiryDate: '2026-12-01T00:00:00.000Z',
  lastScanResult: null,
  liveResult: null,
});

const marketWithOpportunity = (id: string, eventTitle: string): SavedMarket => ({
  ...market(id, eventTitle, 'Politics'),
  lastScanResult: {
    scannedAt: '2026-08-12T18:00:00.000Z',
    bestRoiPct: 5,
    bestProfit: 10,
    matchedCount: 1,
    allArbs: [{
      artist: 'Candidate A',
      strategy: 'Buy YES Kalshi + NO Polymarket',
      expectedProfit: 10,
      roiPct: 5,
      totalStake: 200,
      kalshiTicker: 'KXTEST',
      kalshiYesAsk: 0.4,
      kalshiNoAsk: 0.6,
      pmConditionId: 'pm-test',
      pmYesPrice: 0.45,
      pmNoPrice: 0.55,
    }],
  } as SavedMarket['lastScanResult'],
});

const props = {
  loading: false,
  onLoad: vi.fn(),
  sort: 'name' as const,
  sortDir: 'asc' as const,
  onToggleSort: vi.fn(),
  layout: 'grid' as const,
  onToggleLayout: vi.fn(),
  expiryFilter: 'all' as const,
  onSetExpiryFilter: vi.fn(),
  showArbOnly: false,
  onToggleShowArbOnly: vi.fn(),
  showExpired: true,
  onToggleShowExpired: vi.fn(),
  timeUntilExpiry: () => '126d',
  formatExpiry: () => 'Dec 1',
  onSelectMarket: vi.fn(),
};

describe('OverviewPanel market navigation', () => {
  it('opens the exact affected market when its title is clicked', () => {
    const affectedMarket = market(
      'd782d04f-f297-4c5e-9e02-6ddc3fa8b607',
      'South Carolina Senate Special Republican Primary: First Round Winner',
      'Politics',
    );
    const onSelectMarket = vi.fn();

    render(<OverviewPanel {...props} onSelectMarket={onSelectMarket} markets={[affectedMarket]} />);
    fireEvent.click(screen.getByRole('heading', { name: affectedMarket.eventTitle }));

    expect(onSelectMarket).toHaveBeenCalledOnce();
    expect(onSelectMarket).toHaveBeenCalledWith(affectedMarket);
  });
});

describe('OverviewPanel category filter', () => {
  it('lists discovered categories and shows only the selected category', () => {
    render(<OverviewPanel {...props} markets={[
      market('sports', 'Football final', 'Sports'),
      market('politics', 'Election', 'Politics'),
      market('uncategorized', 'Unclassified'),
    ]} />);

    const categoryFilter = screen.getByRole('combobox', { name: /category/i });
    expect(categoryFilter.textContent).toContain('All categories');
    expect(categoryFilter.textContent).toContain('Sports');
    expect(categoryFilter.textContent).toContain('Politics');

    fireEvent.change(categoryFilter, { target: { value: 'sports' } });
    expect(screen.getByText('Football final')).toBeTruthy();
    expect(screen.queryByText('Election')).toBeNull();
    expect(screen.queryByText('Unclassified')).toBeNull();
  });
});

describe('BUG-133 canonical matched state', () => {
  it('shows matched pairs separately from a no-arbitrage strategy', () => {
    const tx07 = marketWithOpportunity('tx-07', 'TX-07 House Election Winner');
    tx07.lastScanResult = {
      ...tx07.lastScanResult!, bestRoiPct: 0, bestProfit: 0, strategy: 'No arb',
      matchedCount: 2, matchStatus: 'matched', allArbs: [],
    } as SavedMarket['lastScanResult'];

    render(<OverviewPanel {...props} layout="table" markets={[tx07]} />);

    expect(screen.getByText('2 matched')).toBeTruthy();
    expect(screen.getByText('No arb')).toBeTruthy();
  });

  it.each([
    ['not_scanned', 'Not scanned'],
    ['refreshing', 'Refreshing'],
    ['unavailable', 'Unavailable: Polymarket unavailable'],
    ['confirmed_zero', '0 matched'],
  ] as const)('renders %s without conflating it with a confirmed zero', (matchStatus, label) => {
    const affected = market('affected', 'Affected market', 'Politics');
    affected.lastScanResult = {
      scannedAt: matchStatus === 'not_scanned' ? null : '2026-08-12T18:00:00.000Z',
      bestRoiPct: 0, bestProfit: 0,
      strategy: matchStatus === 'not_scanned' ? 'Not scanned' : 'No arb',
      matchedCount: 0, matchStatus,
      matchError: matchStatus === 'unavailable' ? 'Polymarket unavailable' : undefined,
      allArbs: [],
    } as SavedMarket['lastScanResult'];

    render(<OverviewPanel {...props} layout="table" markets={[affected]} />);

    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });
});

describe.each([
  ['desktop', 1440],
  ['mobile', 375],
])('BUG-132 Markets-first layout on %s', (_viewport, width) => {
  it('keeps Opportunity Queue out of Markets and renders it only in its canonical view', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    const opportunityMarket = marketWithOpportunity('opportunity', 'Election winner');
    const { rerender } = render(
      <OverviewPanel {...props} mode="markets" markets={[opportunityMarket]} />,
    );

    expect(screen.getByRole('heading', { name: 'Markets' })).toBeTruthy();
    expect(screen.getByText('Avg Yield')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /opportunity queue/i })).toBeNull();

    rerender(
      <OverviewPanel {...props} mode="opportunities" markets={[opportunityMarket]} />,
    );

    expect(screen.queryByRole('heading', { name: 'Markets' })).toBeNull();
    expect(screen.getAllByRole('region', { name: /opportunity queue/i })).toHaveLength(1);
  });
});
