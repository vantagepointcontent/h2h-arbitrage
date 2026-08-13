import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  quickPricesScan: vi.fn(),
  reconcileSavedMarketMatchSummary: vi.fn(),
  reserveSavedMarketPublication: vi.fn(),
  consume: vi.fn(() => ({ allowed: true })),
}));

vi.mock('@/lib/quick-prices', () => ({ quickPricesScan: mocks.quickPricesScan }));
vi.mock('@/lib/persistence', () => ({
  reconcileSavedMarketMatchSummary: mocks.reconcileSavedMarketMatchSummary,
  reserveSavedMarketPublication: mocks.reserveSavedMarketPublication,
}));
vi.mock('@/lib/scan-rate-limit', () => ({
  scanRateLimiter: { consume: mocks.consume },
  getScanClientKey: () => 'test',
}));

import { POST } from './route';

describe('POST /api/quick-prices diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reserveSavedMarketPublication.mockResolvedValue(7);
    mocks.reconcileSavedMarketMatchSummary.mockResolvedValue(undefined);
  });

  it('atomically reconciles canonical pair ids before returning a successful detail refresh', async () => {
    const result = {
      matchedCount: 2,
      matchStatus: 'matched',
      matchedPairs: [
        { artist: 'Democratic', kalshiTicker: 'TX07-D', pmConditionId: 'pm-d' },
        { artist: 'Republican', kalshiTicker: 'TX07-R', pmConditionId: 'pm-r' },
      ],
      _pmFetchedAt: '2026-08-12T19:49:14.096Z',
    };
    mocks.quickPricesScan.mockResolvedValue(result);
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketId: 'tx-07', capital: 1000 }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenNthCalledWith(1, 'tx-07', {
      matchedCount: 0,
      matchStatus: 'refreshing',
      matchError: undefined,
      matchedPairs: undefined,
      scannedAt: expect.any(String),
      publicationGeneration: 7,
    });
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenNthCalledWith(2, 'tx-07', {
      matchedCount: 2,
      matchStatus: 'matched',
      matchError: undefined,
      matchedPairs: result.matchedPairs,
      scannedAt: result._pmFetchedAt,
      publicationGeneration: 7,
    });
  });

  it('returns an actionable failure with the request correlation ID', async () => {
    mocks.quickPricesScan.mockRejectedValue(new Error('unexpected internal failure'));
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'quick-test-cid' },
      body: JSON.stringify({ marketId: 'saved-1', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get('x-correlation-id')).toBe('quick-test-cid');
    expect(body.error).toMatch(/^Saved-market price refresh failed \(Error, ref: [a-f0-9]{16}\/quick-test-cid\)$/);
    expect(body.error).not.toContain('Unknown error');
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith('saved-1', {
      matchedCount: 0,
      matchStatus: 'unavailable',
      matchError: body.error,
      matchedPairs: undefined,
      scannedAt: expect.any(String),
      publicationGeneration: 7,
    });
  });

  it('returns an actionable missing saved-market response with diagnostics', async () => {
    const error = Object.assign(new Error('Market not found'), { status: 404 });
    mocks.quickPricesScan.mockRejectedValue(error);
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'quick-missing-cid' },
      body: JSON.stringify({ marketId: 'deleted-market', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(response.headers.get('x-correlation-id')).toBe('quick-missing-cid');
    expect(body.error).toMatch(
      /^Saved market not found\. It may have been removed; return to Markets and select it again\. \(Error, ref: [a-f0-9]{16}\/quick-missing-cid\)$/,
    );
    expect(body.error).not.toContain('Saved-market price refresh failed');
  });

  it('returns an actionable invalid Kalshi-link response with diagnostics', async () => {
    const error = Object.assign(new Error('A valid Kalshi market link is required.'), { status: 400 });
    mocks.quickPricesScan.mockRejectedValue(error);
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'quick-kalshi-link-cid' },
      body: JSON.stringify({ marketId: 'stale-kalshi-link', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get('x-correlation-id')).toBe('quick-kalshi-link-cid');
    expect(body.error).toMatch(
      /^Saved market has an invalid Kalshi link\. Return to Markets and update or re-add this saved market\. \(Error, ref: [a-f0-9]{16}\/quick-kalshi-link-cid\)$/,
    );
    expect(body.error).not.toContain('Saved-market price refresh failed');
  });

  it('returns an actionable invalid Polymarket-link response with diagnostics', async () => {
    const error = Object.assign(new Error('A valid Polymarket market link is required.'), { status: 400 });
    mocks.quickPricesScan.mockRejectedValue(error);
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'quick-pm-link-cid' },
      body: JSON.stringify({ marketId: 'stale-pm-link', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get('x-correlation-id')).toBe('quick-pm-link-cid');
    expect(body.error).toMatch(
      /^Saved market has an invalid Polymarket link\. Return to Markets and update or re-add this saved market\. \(Error, ref: [a-f0-9]{16}\/quick-pm-link-cid\)$/,
    );
    expect(body.error).not.toContain('Saved-market price refresh failed');
  });
});
