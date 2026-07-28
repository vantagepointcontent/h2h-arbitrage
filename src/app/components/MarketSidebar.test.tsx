// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NavButton } from './MarketSidebar';

describe('NavButton mobile accessibility', () => {
  it.each([
    ['expanded navigation', false],
    ['collapsed navigation', true],
  ])('provides a 44px minimum tap target for %s', (_name, collapsed) => {
    render(
      <NavButton
        icon={<span aria-hidden="true">M</span>}
        label="Markets"
        active={false}
        collapsed={collapsed}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Markets' }).className).toContain('min-h-11');
  });
});