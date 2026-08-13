// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './switch';

describe('Switch', () => {
  it('keeps the thumb contained in the canonical track in both states', () => {
    const { rerender } = render(
      <Switch aria-label="Polymarket" checked={false} onCheckedChange={() => {}} />,
    );

    const control = screen.getByRole('switch', { name: 'Polymarket' });
    const track = control.firstElementChild as HTMLElement;
    const thumb = track.firstElementChild as HTMLElement;

    expect(control.className).toContain('min-h-11');
    expect(track.className).toContain('h-6');
    expect(track.className).toContain('w-11');
    expect(track.className).toContain('overflow-hidden');
    expect(thumb.className).toContain('left-0');
    expect(thumb.className).toContain('translate-x-0.5');

    rerender(<Switch aria-label="Polymarket" checked onCheckedChange={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Polymarket' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('switch', { name: 'Polymarket' }).firstElementChild?.firstElementChild as HTMLElement).className)
      .toContain('translate-x-[22px]');
  });

  it('uses a keyboard-native button and preserves disabled semantics', () => {
    const onCheckedChange = vi.fn();
    const { rerender } = render(
      <Switch aria-label="Kalshi" checked={false} onCheckedChange={onCheckedChange} />,
    );

    const control = screen.getByRole('switch', { name: 'Kalshi' });
    expect(control.tagName).toBe('BUTTON');
    expect(control.getAttribute('type')).toBe('button');
    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(true);

    rerender(<Switch aria-label="Kalshi" checked={false} disabled onCheckedChange={onCheckedChange} />);
    const disabledControl = screen.getByRole('switch', { name: 'Kalshi' });
    expect(disabledControl.hasAttribute('disabled')).toBe(true);
    fireEvent.click(disabledControl);
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
  });
});
