// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { ShareStakeCalculator } from './ShareStakeCalculator';

describe('ShareStakeCalculator', () => {
  const props = {
    strategy: 'Buy YES Kalshi + NO PM' as const,
    kalshiYesAsk: 0.45,
    kalshiNoAsk: 0.56,
    pmYesAsk: 0.52,
    pmNoAsk: 0.5,
    kalshiAskDepth: '47',
    pmAskDepth: 2,
    category: 'Politics',
    formatCurrency: (value: number) => `$${value.toFixed(2)}`,
  };

  it('shows per-leg executable depth and recalculates the net result as shares change', () => {
    render(createElement(ShareStakeCalculator, props));

    expect((screen.getByLabelText('Shares per leg') as HTMLInputElement).value).toBe('1');
    expect(screen.getByText('Available at best ask: 47 shares')).toBeTruthy();
    expect(screen.getByText('Available at best ask: 2 shares')).toBeTruthy();
    expect(screen.getByText(/net profit/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Shares per leg'), { target: { value: '3' } });
    expect(screen.getByRole('alert').textContent).toContain('Only 2 shares available at this price on Polymarket.');
    expect(screen.getByText('Cost: $1.35')).toBeTruthy();
  });

  it('does not present non-numeric liquidity as fillable depth', () => {
    render(createElement(ShareStakeCalculator, { ...props, kalshiAskDepth: '$100K', pmAskDepth: undefined }));
    expect(screen.getAllByText(/Unavailable — do not assume fillable/i)).toHaveLength(2);
  });
});
