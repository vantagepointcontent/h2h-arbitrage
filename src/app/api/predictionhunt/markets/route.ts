import { NextRequest, NextResponse } from 'next/server';
import {
  getPredictionHuntMarkets,
  runFullSync,
  getLatestSyncLog,
  fetchAllPlatformMarkets,
} from '@/lib/predictionhunt';
import { addSavedMarket, upsertSavedMarket } from '@/lib/persistence';

/* ═══════════════════════════════════════════════════════════════
   GET /api/predictionhunt/markets
   Return all cached PredictionHunt markets + last sync log.
   ═══════════════════════════════════════════════════════════════ */
export async function GET() {
  try {
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
