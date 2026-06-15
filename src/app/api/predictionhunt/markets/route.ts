import { NextRequest, NextResponse } from 'next/server';
import {
  getPredictionHuntMarkets,
  runFullSync,
  getLatestSyncLog,
  fetchAllPlatformMarkets,
  CATEGORIES,
  fetchPlatformMarkets,
  buildMatches,
  RATE_LIMIT_MS,
  PhV2Market,
} from '@/lib/predictionhunt';
import { addSavedMarket, upsertSavedMarket } from '@/lib/persistence';

/* ═══════════════════════════════════════════════════════════════
   GET /api/predictionhunt/markets
   Return cached markets OR fetch fresh by category + expiry window.
   Query params:
     - category: comma-separated list (e.g. sports,politics)
     - maxDays: number 1-365, filters eventDate <= now + maxDays
   ═══════════════════════════════════════════════════════════════ */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const categoryParam = searchParams.get('category');
    const maxDaysParam = searchParams.get('maxDays');

    // Fresh fetch requested for specific categories/expiry
    if (categoryParam || maxDaysParam) {
      const categories = categoryParam
        ? categoryParam.split(',').map(c => c.trim().toLowerCase()).filter(Boolean)
        : CATEGORIES;
      const maxDays = maxDaysParam ? Math.min(365, Math.max(1, parseInt(maxDaysParam, 10))) : 365;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + maxDays);

      const [pmMarkets, kMarkets] = await Promise.all([
        fetchCategories('polymarket', categories),
        fetchCategories('kalshi', categories),
      ]);

      const matches = buildMatches(pmMarkets, kMarkets).filter(m => {
        if (!m.eventDate) return true;
        return new Date(m.eventDate).getTime() <= cutoff.getTime();
      });

      return NextResponse.json({
        success: true,
        count: matches.length,
        markets: matches,
        fresh: true,
        categories,
        maxDays,
      }, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        }
      });
    }

    // Default: return cached markets + last sync log
    const [markets, syncLog] = await Promise.all([
      getPredictionHuntMarkets(),
      getLatestSyncLog(),
    ]);

    return NextResponse.json({
      success: true,
      count: markets.length,
      markets,
      lastSync: syncLog,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      }
    });
  } catch (err: any) {
    console.error('[api/predictionhunt/markets GET]', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** Fetch a subset of categories for a platform. */
async function fetchCategories(platform: string, categories: string[]): Promise<PhV2Market[]> {
  const all: PhV2Market[] = [];
  for (const cat of categories) {
    try {
      const ms = await fetchPlatformMarkets(platform, cat);
      all.push(...ms);
    } catch (e: any) {
      console.warn(`[ph] ${platform}/${cat} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }
  return all;
}

/* ═══════════════════════════════════════════════════════════════
   POST /api/predictionhunt/markets?action=sync
   Trigger a full sync from PredictionHunt API.
   ═══════════════════════════════════════════════════════════════ */
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');

    /* ── Fetch all markets from both platforms (raw, unmatched) ── */
    if (action === 'fetch-all') {
      const [pmMarkets, kMarkets] = await Promise.all([
        fetchAllPlatformMarkets('polymarket'),
        fetchAllPlatformMarkets('kalshi'),
      ]);
      return NextResponse.json({
        success: true,
        polymarket: pmMarkets,
        kalshi: kMarkets,
        total: pmMarkets.length + kMarkets.length,
      });
    }

    /* ── Sync all markets ─────────────────────────── */
    if (action === 'sync') {
      const log = await runFullSync();
      return NextResponse.json({
        success: true,
        synced: log,
      });
    }

    /* ── Save single market to H2H saved-markets ────
     * Uses upsert: updates in-place if already saved (preserving favorite),
     * creates new if not yet saved. */
    if (action === 'save-to-h2h') {
      const body = await request.json();
      if (!body.polymarketUrl || !body.kalshiUrl) {
        return NextResponse.json(
          { success: false, error: 'Missing polymarketUrl or kalshiUrl' },
          { status: 400 }
        );
      }

      const market = await upsertSavedMarket({
        kalshiUrl: body.kalshiUrl,
        polymarketUrl: body.polymarketUrl,
        eventTitle: body.title || 'Untitled',
        category: body.category || '',
        expiryDate: body.expiryDate || null,
      });

      return NextResponse.json({ success: true, market }, { status: 200 });
    }

    return NextResponse.json(
      { success: false, error: 'Unknown action. Use ?action=sync or ?action=save-to-h2h' },
      { status: 400 }
    );
  } catch (err: any) {
    console.error('[api/predictionhunt/markets POST]', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
