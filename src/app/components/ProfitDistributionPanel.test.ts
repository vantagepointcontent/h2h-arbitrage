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

  it('is collapsed by default and emits recalculated stake distribution while dragging', () => {
    const onChange = vi.fn();
    render(createElement(ProfitDistributionPanel, { ...props, onChange }));

    const toggle = screen.getByRole('button', { name: /profit distribution/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Profit distribution')).toBeNull();

    fireEvent.click(toggle);
    const slider = screen.getByLabelText('Profit distribution') as HTMLInputElement;
    expect(slider.value).toBe('50');
    fireEvent.change(slider, { target: { value: '100' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ splitPct: 100, totalStake: 95 });
    expect(onChange.mock.calls[0][0].kalshiStake).toBeCloseTo(95, 8);
    expect(onChange.mock.calls[0][0].pmStake).toBeCloseTo(0, 8);
    expect(screen.getByText('Recalculated fees')).toBeTruthy();
  });
});
