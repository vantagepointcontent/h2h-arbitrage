// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BundledMatchBuilder from './BundledMatchBuilder';

const kalshi = [{ ticker: 'KX20', title: 'At least 20%', yesAsk: 0.11, noAsk: 0.90 }];
const polymarket = [
  { conditionId: 'P20', title: '20-25%', yesPrice: 0.06, noPrice: 0.94 },
  { conditionId: 'P25', title: '25-30%', yesPrice: 0.08, noPrice: 0.92 },
  { conditionId: 'P30', title: '30%+', yesPrice: 0.07, noPrice: 0.93 },
];

describe('BundledMatchBuilder', () => {
  it('exposes bundled mode, per-leg orientation, budget, mapping preview and preview-only safety', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ matches: [] }) })));
    render(<BundledMatchBuilder kalshiMarkets={kalshi} polymarketMarkets={polymarket} onSaved={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /bundled matching/i })).toBeTruthy();
    expect(screen.getByLabelText(/total budget/i)).toBeTruthy();
    expect(screen.getAllByLabelText(/orientation/i).length).toBeGreaterThan(1);
    fireEvent.change(screen.getAllByLabelText(/orientation/i)[1], { target: { value: 'inverted' } });
    expect(screen.getByText(/YES.*normalized NO/i)).toBeTruthy();
    expect(screen.getByText(/preview only.*never places trades/i)).toBeTruthy();
  });
});
