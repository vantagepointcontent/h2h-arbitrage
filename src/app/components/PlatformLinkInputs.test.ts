// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, useState } from 'react';
import { PlatformLinkInputs, type PlatformLinkInput } from './PlatformLinkInputs';

function Harness() {
  const [links, setLinks] = useState<PlatformLinkInput[]>([
    { id: 'kalshi', platform: 'kalshi', url: '' },
    { id: 'polymarket', platform: 'polymarket', url: '' },
  ]);
  return createElement(PlatformLinkInputs, { links, onChange: setLinks });
}

describe('PlatformLinkInputs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds and focuses a third link when crypto.randomUUID is unavailable over HTTP', () => {
    vi.stubGlobal('crypto', undefined);
    render(createElement(Harness));

    fireEvent.click(screen.getByRole('button', { name: /add platform link/i }));

    expect(screen.getByText('Link 3')).toBeTruthy();
    const urls = screen.getAllByRole('textbox');
    expect(urls).toHaveLength(3);
    expect(document.activeElement).toBe(urls[2]);
  });

  it('stores the detected platform with the URL instead of retaining the row default', () => {
    render(createElement(Harness));

    fireEvent.change(screen.getAllByRole('textbox')[0], {
      target: { value: 'https://www.interactivebrokers.com/predictionmarkets/app/market/123' },
    });

    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('ibkr');
  });
});
