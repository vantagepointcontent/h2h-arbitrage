// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { ProfitDistributionPanel } from './ProfitDistributionPanel';

describe('ProfitDistributionPanel', () => {
  const props = {
    strategy: 'Buy YES Kalshi + NO PM' as const,
    kalshiPrice: 0.45,
    pmPrice: 0.5,
    kalshiStake: 45,
    pmStake: 50,
    kalshiWinLabel: 'Kalshi YES',
    pmWinLabel: 'Polymarket NO',
    formatCurrency: (value: number) => `$${value.toFixed(2)}`,
  };

  it('is collapsed by default and locks the canonical one-share distribution', () => {
    const onChange = vi.fn();
    render(createElement(ProfitDistributionPanel, { ...props, onChange }));

    const toggle = screen.getByRole('button', { name: /profit distribution/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Profit distribution')).toBeNull();

    fireEvent.click(toggle);
    const slider = screen.getByLabelText('Profit distribution') as HTMLInputElement;
    expect(slider.value).toBe('50');
    expect(slider.disabled).toBe(true);
    expect(screen.getAllByText('1 shares', { exact: false })).toHaveLength(2);
    expect(screen.getByText('PM:Kalshi 1:1')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/exactly one contract\/share on each venue/i)).toBeTruthy();
    expect(screen.getByText('Recalculated fees')).toBeTruthy();
  });
});
