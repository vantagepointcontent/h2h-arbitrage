// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MarketDepthCharts } from './MarketDepthCharts';

const depthResponse = {
  updatedAt: '2026-07-23T00:00:00.000Z',
  kalshi: {
    label: 'Kalshi YES',
    bids: [{ price: 0.51, size: 120, cumulativeSize: 120 }],
    asks: [{ price: 0.53, size: 40, cumulativeSize: 40 }],
  },
  polymarket: {
    label: 'Polymarket YES',
    bids: [{ price: 0.5, size: 80, cumulativeSize: 80 }],
    asks: [{ price: 0.54, size: 25, cumulativeSize: 25 }],
  },
};

describe('MarketDepthCharts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders independent bid and ask prices with shares at every level', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => depthResponse }));

    render(createElement(MarketDepthCharts, { kalshiTicker: 'KXTEST', pmConditionId: '0xtest' }));

    await waitFor(() => expect(screen.getAllByText('Bid price')).toHaveLength(2));
    expect(screen.getAllByText('Ask price')).toHaveLength(2);
    expect(screen.getAllByText('51.00¢')).toHaveLength(1);
    expect(screen.getAllByText('53.00¢')).toHaveLength(1);
    expect(screen.getAllByText('120')).toHaveLength(1);
    expect(screen.getAllByText('40')).toHaveLength(1);
  });
});
