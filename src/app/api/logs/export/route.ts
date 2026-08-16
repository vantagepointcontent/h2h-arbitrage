import { NextRequest, NextResponse } from 'next/server';
import { getSavedMarkets, queryScanHistoryStream, countScanHistory } from '@/lib/persistence';
import type { OutcomeContingentApy } from '@/lib/settlement-apy';
import { clientSafeError } from '@/lib/error-handler';
import { classifyArbType } from '@/lib/arb-types';
import { parseExportLimit, parseOptionalFiniteNumber, parseTteMaxDays } from '@/lib/logs-request';
import { getCurrentLogRoiBatch } from '@/lib/current-log-roi.server';
import { compareRoiDecline } from '@/lib/roi-declined';

const CURRENT_ROI_BATCH_SIZE = 100;

const headers = [
  'Scan Time',
  'Market Name',
  'Category',
  'Market ID',
  'Strategy',
  'Arb Type',
  'Arb Valid',
  'Invalidation Reason',
  'ROI %',
  'Current ROI %',
  'ROI Declined?',
  'APY %',
  'APY Unavailable Reason',
  'Scenario A Winner',
  'Scenario A Settlement',
  'Scenario A APY %',
  'Scenario A Timing Source',
  'Scenario A Unavailable Reason',
  'Scenario B Winner',
  'Scenario B Settlement',
  'Scenario B APY %',
  'Scenario B Timing Source',
  'Scenario B Unavailable Reason',
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

function toIsoDate(value: string | null): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date value: "${value}"`);
  }
  return d.toISOString();
}

function buildFilters(searchParams: URLSearchParams) {
  const marketId = searchParams.get('marketId') || undefined;
  const minRoi = parseOptionalFiniteNumber(searchParams.get('minRoi'));
  const positiveArbOnly = searchParams.get('positiveArbOnly') === 'true';
  const search = searchParams.get('search') || undefined;
  const eventType = searchParams.get('eventType') as 'all' | 'scan' | 'arb' | 'system' | null;
  const arbType = searchParams.get('arbType') as 'all' | 'direct' | 'cross' | 'internal' | null;
  const maxTteDays = parseTteMaxDays(searchParams.get('maxTteDays'));
  const fromDate = toIsoDate(searchParams.get('fromDate'));
  const toDate = toIsoDate(searchParams.get('toDate'));
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error('fromDate must be before or equal to toDate');
  }
  const maxRows = parseExportLimit(searchParams.get('limit'));
  return { marketId, minRoi, positiveArbOnly, fromDate, toDate, search, eventType: eventType ?? undefined, arbType: arbType ?? undefined, maxTteDays, maxRows };
}

function isValidationError(err: unknown): err is Error {
  return err instanceof Error && (
    err.message.startsWith('Invalid date value') ||
    err.message.startsWith('fromDate must be')
  );
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
          const ids = batch.map((row) => Number(row.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
          const currentRoiPages = await Promise.all(Array.from(
            { length: Math.ceil(ids.length / CURRENT_ROI_BATCH_SIZE) },
            (_, index) => getCurrentLogRoiBatch(ids.slice(index * CURRENT_ROI_BATCH_SIZE, (index + 1) * CURRENT_ROI_BATCH_SIZE)),
          ));
          const currentRoiById = new Map(currentRoiPages.flat().map((valuation) => [valuation.id, valuation]));
          for (const r of batch) {
            let outcomeApy: OutcomeContingentApy | null = null;
            try {
              const raw = typeof r.raw_result === 'string'
                ? JSON.parse(r.raw_result) as { outcomeApy?: OutcomeContingentApy; allArbs?: Array<{ outcomeApy?: OutcomeContingentApy }> }
                : null;
              outcomeApy = raw?.outcomeApy ?? raw?.allArbs?.[0]?.outcomeApy ?? null;
            } catch { /* malformed legacy payload: export explicit blank provenance */ }
            const currentRoi = currentRoiById.get(Number(r.id));
            const currentRoiPct = currentRoi?.status === 'available'
              && typeof currentRoi.roiPct === 'number'
              && Number.isFinite(currentRoi.roiPct)
              ? currentRoi.roiPct
              : null;
            const roiDeclined = compareRoiDecline(r.best_roi_pct, currentRoiPct).declined;
            const line = [
              r.scanned_at,
              r.market_title ?? nameMap.get(r.market_id) ?? '',
              categoryMap.get(r.market_id) ?? '',
              r.market_id,
              r.strategy,
              r.arb_valid === 1 ? (r.arb_type ?? classifyArbType(r.strategy) ?? '') : '',
              r.arb_valid === 1 ? 'true' : 'false',
              r.arb_invalidation_reason ?? '',
              r.best_roi_pct,
              currentRoiPct,
              roiDeclined ? 'TRUE' : 'FALSE',
              r.apy_pct,
              r.apy_unavailable_reason,
              outcomeApy?.scenarioA?.winner,
              outcomeApy?.scenarioA?.settlementAt,
              outcomeApy?.scenarioA?.apyPct,
              outcomeApy?.scenarioA?.timingSource,
              outcomeApy?.scenarioA?.unavailableReason,
              outcomeApy?.scenarioB?.winner,
              outcomeApy?.scenarioB?.settlementAt,
              outcomeApy?.scenarioB?.apyPct,
              outcomeApy?.scenarioB?.timingSource,
              outcomeApy?.scenarioB?.unavailableReason,
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
    if (isValidationError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
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
        'X-Export-Max-Rows': filters.maxRows === undefined ? 'unlimited' : String(filters.maxRows),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err) {
    if (isValidationError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to estimate export size') },
      { status: 500 }
    );
  }
}
