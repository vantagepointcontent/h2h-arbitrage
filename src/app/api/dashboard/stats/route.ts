import { NextRequest, NextResponse } from 'next/server';
import { getDashboardAggregates, getSavedMarkets } from '@/lib/persistence';
import { classifyMarket } from '@/lib/market-classification';
import { clientSafeError } from '@/lib/error-handler';

/**
 * GET /api/dashboard/stats
 *
 * Query params:
 *   range   — "today" | "7d" | "30d" | "90d" | "all" (default: "30d")
 *
 * Returns aggregated dashboard statistics from scan_results.
 * PERF-P4: all row aggregation happens in SQLite (GROUP BY / window fn);
 * only the market-coverage pie (needs classifyMarket) stays in JS over the
 * ~500 saved markets.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '30d';

    // Compute cutoff date
    let since: string | undefined;
    const now = new Date();
    switch (range) {
      case 'today':
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        break;
      case '7d':
        since = new Date(now.getTime() - 7 * 86400000).toISOString();
        break;
      case '90d':
        since = new Date(now.getTime() - 90 * 86400000).toISOString();
        break;
      case '30d':
        since = new Date(now.getTime() - 30 * 86400000).toISOString();
        break;
      case 'all':
        since = undefined;
        break;
      default:
        since = new Date(now.getTime() - 30 * 86400000).toISOString();
    }

    // Phantom guard: rows with ROI above the suspicious threshold are
    // one-tick empty-book quotes, not fillable arbs. They stay in scan
    // counts/histograms but are excluded from ROI/profit KPIs and top arbs.
    const SUSPICIOUS_ROI = Number(process.env.H2H_SUSPICIOUS_ROI_PCT || 25);

    const agg = await getDashboardAggregates(since, SUSPICIOUS_ROI);

    // ── Market Coverage (pie chart data) ───────────────────────
    // classifyMarket is JS-only — runs over ~500 saved markets, cheap.
    const savedMarkets = await getSavedMarkets();

    // BUG-01: "Active Arbs Now" counter — count distinct markets where the
    // latest scan (liveResult ?? lastScanResult) has bestRoiPct > 0.
    // This matches the MarketSidebar "Arb Only" filter exactly: same data
    // source (saved_markets), same criteria (roi > 0), no time window.
    // Previously the counter summed positive_arb_count from scan_results in
    // the last 5 minutes — a different metric (outcome count, time-limited)
    // that never matched the sidebar filter count.
    const activeArbsCount = savedMarkets.filter(m => {
      const roi = m.liveResult?.bestRoiPct ?? m.lastScanResult?.bestRoiPct ?? 0;
      return roi > 0;
    }).length;
    agg.kpis.activeArbs = activeArbsCount;
    const marketCategoryCounts: Record<string, number> = {
      Politics: 0,
      Sports: 0,
      Crypto: 0,
      Economics: 0,
      Entertainment: 0,
      Other: 0,
    };
    for (const m of savedMarkets) {
      const title = m.eventTitle || '';
      const cls = classifyMarket(title);
      const map: Record<string, keyof typeof marketCategoryCounts> = {
        politics: 'Politics',
        sports: 'Sports',
        crypto: 'Crypto',
        finance: 'Economics',
        entertainment: 'Entertainment',
      };
      const mapped = map[cls.domain] || 'Other';
      marketCategoryCounts[mapped]++;
    }
    const marketCoverage = Object.entries(marketCategoryCounts).map(([name, value]) => ({
      name,
      value,
    }));

    // Expired: saved markets past their expiry date
    const expiredArbs = savedMarkets.filter(
      (m) => m.expiryDate && new Date(m.expiryDate) < now
    ).length;

    // ── Top Active Arbs (live data) ────────────────────────────
    // BUG: topActiveArbs previously came from scan_results with
    // ROW_NUMBER ORDER BY best_roi_pct DESC — it showed the HIGHEST ROI
    // ever recorded for each market in the time range, not current ROI.
    // Now computed from savedMarkets using liveResult ?? lastScanResult,
    // the same data source as the MarketSidebar. This ensures the
    // dashboard table and sidebar show consistent ROI for the same market.
    const SUSPICIOUS_ROI_THRESHOLD = SUSPICIOUS_ROI;
    const topActiveArbs = savedMarkets
      .map(m => {
        const live = m.liveResult ?? m.lastScanResult;
        if (!live || live.bestRoiPct <= 0 || live.bestRoiPct > SUSPICIOUS_ROI_THRESHOLD) return null;
        const allArbs = live.allArbs ?? [];
        const positiveArbCount = allArbs.filter(a => a.expectedProfit > 0).length;
        return {
          id: 0, // no DB row id — using market id instead
          market_id: m.id,
          market_title: m.eventTitle || null,
          best_roi_pct: live.bestRoiPct,
          best_profit: live.bestProfit,
          strategy: live.strategy || '',
          positive_arb_count: positiveArbCount,
          scanned_at: live.scannedAt || '',
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .sort((a, b) => b.best_roi_pct - a.best_roi_pct)
      .slice(0, 10);

    const lifecycleFunnel = {
      found: agg.kpis.totalArbsFound,
      active: agg.kpis.activeArbs,
      recurring: agg.recurringArbs,
      vanished: agg.vanishedArbs,
      expired: expiredArbs,
    };

    return NextResponse.json({
      kpis: agg.kpis,
      scansPerDay: agg.scansPerDay,
      roiDistribution: agg.roiBuckets,
      timeline: agg.timeline,
      topActiveArbs,
      marketCoverage,
      profitTimeline: agg.profitTimeline,
      lifecycleFunnel,
      arbTypeBreakdown: agg.arbTypeBreakdown,
      range,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to fetch dashboard stats') },
      { status: 500 }
    );
  }
}
