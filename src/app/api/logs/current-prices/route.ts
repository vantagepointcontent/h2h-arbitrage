import { NextRequest, NextResponse } from 'next/server';
import { fetchCurrentLegQuotes, type CurrentQuoteRequest } from '@/lib/current-log-quotes.server';
import { consumeCurrentPriceGlobalRateLimit } from '@/lib/current-price-rate-limit';
import { parseJsonObject } from '@/lib/request-json';

const KALSHI_MARKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const POLYMARKET_CONDITION_ID = /^0x[0-9a-fA-F]{64}$/;

function isValidMarketId(platform: CurrentQuoteRequest['platform'], marketId: string): boolean {
  if (marketId !== marketId.trim()) return false;
  return platform === 'kalshi'
    ? KALSHI_MARKET_ID.test(marketId)
    : POLYMARKET_CONDITION_ID.test(marketId);
}

function parseLegs(value: unknown): CurrentQuoteRequest[] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const legs: CurrentQuoteRequest[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null;
    const { platform, marketId, outcome } = candidate as Record<string, unknown>;
    if ((platform !== 'kalshi' && platform !== 'polymarket')
      || typeof marketId !== 'string' || !isValidMarketId(platform, marketId)
      || (outcome !== 'yes' && outcome !== 'no')) return null;
    legs.push({ platform, marketId, outcome });
  }
  if (new Set(legs.map((leg) => leg.platform)).size !== 2) return null;
  return legs;
}

export async function POST(request: NextRequest) {
  const rateLimit = consumeCurrentPriceGlobalRateLimit();
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many current-price requests. Please retry shortly.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(rateLimit.retryAfterSeconds),
          'X-RateLimit-Remaining': '0',
        },
      },
    );
  }

  const parsed = await parseJsonObject(request);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const legs = parseLegs(parsed.body.legs);
  if (!legs) {
    return NextResponse.json(
      { error: 'Expected exactly one Kalshi leg and one Polymarket leg with captured market and outcome identifiers.' },
      { status: 400 },
    );
  }

  try {
    const quotes = await fetchCurrentLegQuotes(legs);
    return NextResponse.json({ quotes }, {
      headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' },
    });
  } catch {
    return NextResponse.json({ error: 'Current executable quotes are temporarily unavailable.' }, { status: 503 });
  }
}
