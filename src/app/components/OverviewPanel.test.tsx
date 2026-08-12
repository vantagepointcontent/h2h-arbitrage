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
vi.mock('./ArbLegBreakdown', () => ({ CompactStrategyDisplay: () => null }));

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
