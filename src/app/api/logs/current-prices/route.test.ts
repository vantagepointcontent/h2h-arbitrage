import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ fetchCurrentLegQuotes: vi.fn() }));
vi.mock('@/lib/current-log-quotes.server', () => ({ fetchCurrentLegQuotes: mocks.fetchCurrentLegQuotes }));

import { POST } from './route';
import { resetCurrentPriceRateLimitForTests } from '@/lib/current-price-rate-limit';

const PM_MARKET_ID = `0x${'ab'.repeat(32)}`;

function request(body: unknown, forwardingHeaders: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/logs/current-prices', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...forwardingHeaders },
    body: JSON.stringify(body),
  });
}

describe('POST /api/logs/current-prices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCurrentPriceRateLimitForTests();
  });

  it('fetches exactly the two captured platform market/outcome identities', async () => {
    const legs = [
      { platform: 'kalshi', marketId: 'KX-EXACT', outcome: 'yes' },
      { platform: 'polymarket', marketId: PM_MARKET_ID, outcome: 'no' },
    ];
    mocks.fetchCurrentLegQuotes.mockResolvedValue(legs.map((leg) => ({ ...leg, status: 'available', priceNow: 0.5 })));

    const response = await POST(request({ legs }));

    expect(response.status).toBe(200);
    expect(mocks.fetchCurrentLegQuotes).toHaveBeenCalledWith(legs);
    await expect(response.json()).resolves.toMatchObject({ quotes: expect.any(Array) });
  });

  it('rejects missing identities and extra legs before platform traffic', async () => {
    const response = await POST(request({ legs: [
      { platform: 'kalshi', marketId: '', outcome: 'yes' },
      { platform: 'polymarket', marketId: PM_MARKET_ID, outcome: 'no' },
      { platform: 'kalshi', marketId: 'extra', outcome: 'yes' },
    ] }));

    expect(response.status).toBe(400);
    expect(mocks.fetchCurrentLegQuotes).not.toHaveBeenCalled();
  });

  it.each([
    ['Kalshi whitespace', [
      { platform: 'kalshi', marketId: 'KX BAD', outcome: 'yes' },
      { platform: 'polymarket', marketId: PM_MARKET_ID, outcome: 'no' },
    ]],
    ['Kalshi delimiter', [
      { platform: 'kalshi', marketId: 'KX:BAD', outcome: 'yes' },
      { platform: 'polymarket', marketId: PM_MARKET_ID, outcome: 'no' },
    ]],
    ['non-condition Polymarket id', [
      { platform: 'kalshi', marketId: 'KX-EXACT', outcome: 'yes' },
      { platform: 'polymarket', marketId: '0xexact', outcome: 'no' },
    ]],
    ['unsupported outcome', [
      { platform: 'kalshi', marketId: 'KX-EXACT', outcome: 'maybe' },
      { platform: 'polymarket', marketId: PM_MARKET_ID, outcome: 'no' },
    ]],
  ])('rejects constrained identifier violation: %s', async (_label, legs) => {
    const response = await POST(request({ legs }));

    expect(response.status).toBe(400);
    expect(mocks.fetchCurrentLegQuotes).not.toHaveBeenCalled();
  });

  it('globally limits rotating spoofed forwarding headers before downstream traffic', async () => {
    const legs = [
      { platform: 'kalshi', marketId: 'KX-EXACT', outcome: 'yes' },
      { platform: 'polymarket', marketId: PM_MARKET_ID, outcome: 'no' },
    ];
    mocks.fetchCurrentLegQuotes.mockResolvedValue([]);

    for (let index = 0; index < 10; index += 1) {
      const uniqueLegs = [
        { ...legs[0], marketId: `KX-UNIQUE-${index}` },
        { ...legs[1], marketId: `0x${index.toString(16).padStart(64, '0')}` },
      ];
      expect((await POST(request({ legs: uniqueLegs }, {
        'x-real-ip': `203.0.113.${index + 1}`,
        'x-forwarded-for': `198.51.100.${index + 1}, 100.64.0.1`,
      }))).status).toBe(200);
    }
    const limitedResponses = await Promise.all(Array.from({ length: 15 }, (_, offset) => POST(request({ legs }, {
      'x-real-ip': `192.0.2.${offset + 1}`,
      'x-forwarded-for': `198.18.0.${offset + 1}, 100.64.0.1`,
    }))));

    expect(limitedResponses.map((response) => response.status)).toEqual(Array(15).fill(429));
    expect(Number(limitedResponses[0].headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(mocks.fetchCurrentLegQuotes).toHaveBeenCalledTimes(10);
  });
});
