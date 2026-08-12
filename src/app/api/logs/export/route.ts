import { NextRequest, NextResponse } from 'next/server';
import { queryScanHistoryStream, countScanHistory, getSavedMarkets } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { classifyArbType } from '@/lib/arb-types';
import { parseExportLimit, parseOptionalFiniteNumber } from '@/lib/logs-request';

const headers = [
  'Scan Time',
  'Market Name',
  'Category',
  'Market ID',
  'Strategy',
  'Arb Type',
  'ROI %',
  'APY %',
  'APY Unavailable Reason',
  'Profit ($)',
  'Matched Count',
  'Kalshi Count',
  'PM Count',
  'Positive Arb Count',
  'Total Stake ($)',
  'Outcome Count',
];

const escapeCsv = (val: unknown): string => {
  if (val === null || val === undefined) return '';
  let s = String(val);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) {
    s = `'${s}`;
  }
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

function buildFilters(searchParams: URLSearchParams) {
  const marketId = searchParams.get('marketId') || undefined;
  const minRoi = parseOptionalFiniteNumber(searchParams.get('minRoi'));
  const positiveArbOnly = searchParams.get('positiveArbOnly') === 'true';
  const fromDate = searchParams.get('fromDate') || undefined;
  const toDate = searchParams.get('toDate') || undefined;
  const maxRows = parseExportLimit(searchParams.get('limit'));
  return { marketId, minRoi, positiveArbOnly, fromDate, toDate, maxRows };
}

/**
 * GET /api/logs/export
 *
 * UI-035: streams a CSV download using slim scan columns (no raw_result blob).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = buildFilters(searchParams);

    let nameMap = new Map<string, string>();
    let categoryMap = new Map<string, string>();
    try {
      const saved = await getSavedMarkets();
      nameMap = new Map(saved.map((m) => [m.id, m.eventTitle]));
      categoryMap = new Map(saved.map((m) => [m.id, m.category ?? '']));
    } catch { /* best-effort */ }

    const readable = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(headers.map(escapeCsv).join(',') + '\n'));

        for await (const batch of queryScanHistoryStream(filters)) {
          for (const r of batch) {
            const line = [
              r.scanned_at,
              r.market_title ?? nameMap.get(r.market_id) ?? '',
              categoryMap.get(r.market_id) ?? '',
              r.market_id,
              r.strategy,
              classifyArbType(r.strategy) ?? '',
              r.best_roi_pct,
              r.apy_pct,
              r.apy_unavailable_reason,
              r.best_profit,
              r.matched_count,
              r.kalshi_count,
              r.pm_count,
              r.positive_arb_count,
              r.total_stake,
              r.outcome_count,
            ]
              .map(escapeCsv)
              .join(',');
            controller.enqueue(new TextEncoder().encode(line + '\n'));
          }
        }

        controller.close();
      },
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    return new NextResponse(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="edgefinder-logs-${timestamp}.csv"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to export logs') },
      { status: 500 }
    );
  }
}

/**
 * HEAD /api/logs/export
 *
 * UI-035: returns the same filters' matching row count so the UI can show an
 * estimate before the user downloads a large file.
 */
export async function HEAD(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = buildFilters(searchParams);
    const count = await countScanHistory(filters);
    return new NextResponse(null, {
      status: 200,
      headers: {
        'X-Export-Row-Count': String(count),
        'X-Export-Max-Rows': String(filters.maxRows),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to estimate export size') },
      { status: 500 }
    );
  }
}
