import { NextRequest, NextResponse } from 'next/server';
import { pingPlatform, clearPingCache, pingCacheStats, PingResult } from '@/lib/ping';

const VALID_PLATFORMS = ['kalshi', 'polymarket', 'predictionhunt'];

/* ═══════════════════════════════════════════════════════════════
   POST /api/ping
   Check if a market/event is available on a given platform.
   
   Request body:
   {
     "query": "Trump to win 2024 election" | "https://kalshi.com/markets/...",
     "platform": "kalshi" | "polymarket" | "predictionhunt"
   }
   
   Response:
   {
     "available": true,
     "platform": "kalshi",
     "matches": [...],
     "responseTimeMs": 450,
     "cachedUntil": "2024-01-01T00:05:00Z"
   }
   ═══════════════════════════════════════════════════════════════ */
export async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { query, platform } = body;

    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "query" field (expecting a market title, URL, or search term)' },
        { status: 400 },
      );
    }

    if (!platform || !VALID_PLATFORMS.includes(platform.toLowerCase())) {
      return NextResponse.json(
        { error: `Invalid "platform". Must be one of: ${VALID_PLATFORMS.join(', ')}` },
        { status: 400 },
      );
    }

    const result: PingResult = await pingPlatform(query, platform.toLowerCase());

    return NextResponse.json({
      available: result.available,
      platform: result.platform,
      matches: result.matches,
      responseTimeMs: result.responseTimeMs,
      cachedUntil: new Date(result.cachedUntil).toISOString(),
    }, {
      headers: {
        'Cache-Control': `public, max-age=${Math.floor((result.cachedUntil - Date.now()) / 1000)}, s-maxage=${Math.floor((result.cachedUntil - Date.now()) / 1000)}`,
      },
    });
  } catch (err: any) {
    console.error('[api/ping POST]', err);
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 },
    );
  }
}

/* ═══════════════════════════════════════════════════════════════
   DELETE /api/ping/cache
   Clear all cached ping results.
   ═══════════════════════════════════════════════════════════════ */
export async function DELETE() {
  clearPingCache();
  return NextResponse.json({ cleared: true });
}

/* ═══════════════════════════════════════════════════════════════
   GET /api/ping/stats
   Return cache statistics.
   ═══════════════════════════════════════════════════════════════ */
export async function GET() {
  const stats = pingCacheStats();
  return NextResponse.json(stats);
}
