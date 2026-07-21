import { NextRequest, NextResponse } from 'next/server';
import {
  getPredictionHuntMarkets,
  runFullSync,
  getLatestSyncLog,
  fetchAllPlatformMarkets,
  CATEGORIES,
  fetchPlatformMarkets,
  RATE_LIMIT_MS,
  PredictionHuntMarket,
  CATEGORY_SEARCH_TERMS,
  fetchMatchingMarkets,
  buildMatchedMarketsFromSearch,
} from '@/lib/predictionhunt';
import { upsertSavedMarket } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';
import { parseSavePredictionHuntMarketRequest } from '@/lib/predictionhunt-request';
import { parseBoundedInteger } from '@/lib/request-query';

/* ═══════════════════════════════════════════════════════════════
   GET /api/predictionhunt/markets
   Return cached markets OR fetch fresh by category + expiry window.
   Query params:
     - category: comma-separated list (e.g. sports,politics)
     - maxDays: number 1-365, filters eventDate <= now + maxDays
   ═══════════════════════════════════════════════════════════════ */
/** BUG-037: apply the maxDays expiry window to market rows regardless of
 *  source (fresh fetch OR cached fallback). Undated / invalid / already
 *  expired rows are excluded. */
function applyDateWindow(markets: PredictionHuntMarket[], maxDays: number): PredictionHuntMarket[] {
  const now = Date.now();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + maxDays);
  return markets.filter((m) => {
    if (!m.eventDate) return false;
    const t = new Date(m.eventDate).getTime();
    return !isNaN(t) && t >= now && t <= cutoff.getTime();
  });
}

let phQuotaExhausted = false;
let phQuotaResetAt = 0;

function isPhQuotaExhausted(): boolean {
  if (!phQuotaExhausted) return false;
  // Cooldown: 6 hours after first monthly-exceeded hit
  if (Date.now() > phQuotaResetAt) {
    phQuotaExhausted = false;
    return false;
  }
  return true;
}

function markPhQuotaExhausted(e: any) {
  const msg = e?.message || '';
  if (msg.includes('rate_limit.exceeded_month')) {
    phQuotaExhausted = true;
    phQuotaResetAt = Date.now() + 6 * 60 * 60 * 1000; // 6h cooldown
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const categoryParam = searchParams.get('category');
    const maxDaysParam = searchParams.get('maxDays');
    const fetchCountParam = searchParams.get('fetchCount');

    const categories = categoryParam
      ? categoryParam.split(',').map(c => c.trim().toLowerCase()).filter(Boolean)
      : CATEGORIES;
    const maxDays = parseBoundedInteger(maxDaysParam, 365, 1, 365);
    const fetchCount = parseBoundedInteger(fetchCountParam, 3, 1, 50);

    // If quota is exhausted, skip fresh calls entirely and return cached data
    if (isPhQuotaExhausted()) {
      const cachedAll = await getPredictionHuntMarkets();
      const cached = applyDateWindow(cachedAll, maxDays); // BUG-037
      return NextResponse.json({
        success: true,
        count: cached.length,
        markets: cached,
        fresh: false,
        cached: true,
        quotaWarning: 'PredictionHunt monthly quota exceeded. Showing cached markets only.',
        categories,
        maxDays,
        fetchCount,
      }, {
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' },
      });
    }

    // Fresh fetch requested for specific categories/expiry/fetchCount (or default view)
    if (categoryParam || maxDaysParam || fetchCountParam) {
      // Use PredictionHunt /v2/matching-markets with category-specific search terms
      const allEvents: any[] = [];
      for (const cat of categories) {
        const terms = CATEGORY_SEARCH_TERMS[cat] || [cat];
        for (const term of terms) {
          try {
            const result = await fetchMatchingMarkets(term, { maxDays, limit: 200 });
            allEvents.push(...result.events);
          } catch (e: any) {
            console.warn(`[ph matching-markets] ${cat}/${term} failed: ${e.message}`);
            markPhQuotaExhausted(e);
            if (isPhQuotaExhausted()) break;
          }
          await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
        }
        if (isPhQuotaExhausted()) break;
      }

      let matches: PredictionHuntMarket[] = [];
      let cachedFallback = false;
      let warning: string | undefined;

      if (!isPhQuotaExhausted()) {
        // BUG-037: defensive re-filter — buildMatchedMarketsFromSearch input is
        // pre-filtered per-term, but enforce the window on the final rows too.
        matches = applyDateWindow(buildMatchedMarketsFromSearch(allEvents, fetchCount), maxDays);
      } else {
        matches = applyDateWindow(await getPredictionHuntMarkets(), maxDays); // BUG-037
        cachedFallback = true;
        warning = 'PredictionHunt monthly quota exceeded during fetch. Showing cached markets only.';
      }

      return NextResponse.json({
        success: true,
        count: matches.length,
        markets: matches,
        fresh: !cachedFallback,
        cached: cachedFallback,
        warning,
        categories,
        maxDays,
        fetchCount,
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
      cached: true,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      }
    });
  } catch (err: any) {
    console.error('[api/predictionhunt/markets GET]', err);
    return NextResponse.json({ success: false, error: clientSafeError(err) }, { status: 500 });
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
      const parsed = await parseJsonObject(request);
      if ('error' in parsed) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
      const body = parseSavePredictionHuntMarketRequest(parsed.body);
      if ('error' in body) return NextResponse.json({ success: false, error: body.error }, { status: 400 });

      const market = await upsertSavedMarket({
        kalshiUrl: body.kalshiUrl,
        polymarketUrl: body.polymarketUrl,
        eventTitle: body.title,
        category: body.category,
        expiryDate: body.expiryDate,
      });

      return NextResponse.json({ success: true, market }, { status: 200 });
    }

    return NextResponse.json(
      { success: false, error: 'Unknown action. Use ?action=sync or ?action=save-to-h2h' },
      { status: 400 }
    );
  } catch (err: any) {
    console.error('[api/predictionhunt/markets POST]', err);
    return NextResponse.json({ success: false, error: clientSafeError(err) }, { status: 500 });
  }
}
