import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import {
  suggestCouplings,
  CouplingCandidate,
  CouplingRejection,
  UnmatchedMarket,
} from '@/lib/coupling';
import { getSavedMarkets } from '@/lib/persistence';
import { getPredictionHuntMarkets } from '@/lib/predictionhunt';

const DATA_DIR = path.join(process.cwd(), 'data');

/* ─── GET /api/generous-coupling
 *
 * Returns all unmatched Kalshi + Polymarket markets from saved markets,
 * along with coupling suggestions computed by the coupling engine.
 *
 * Query params:
 *   - minConfidence: minimum confidence score (default: 30)
 *   - maxSuggestions: max suggestions per market (default: 5)
 *   - includeCorrelated: include loosely-correlated matches (default: true)
 *
 * Response:
 * {
 *   kalshiMarkets: MarketEntry[],
 *   pmMarkets: MarketEntry[],
 *   suggestions: CouplingCandidate[],
 *   stats: { kalshiCount, pmCount, suggestionCount, exactCount, looseCount, correlatedCount }
 * }
 * ══════════════════════════════════════════════════════════════════════ */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const minConfidence = parseInt(url.searchParams.get('minConfidence') || '30', 10);
    const maxSuggestions = parseInt(url.searchParams.get('maxSuggestions') || '5', 10);
    const includeCorrelated = url.searchParams.get('includeCorrelated') !== 'false';
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const clampedLimit = Math.min(Math.max(limit, 1), 200);

    // Gather unmatched markets from saved markets' scan results
    const savedMarkets = await getSavedMarkets();
    const phMarkets = await getPredictionHuntMarkets();

    const kalshiEntries: UnmatchedMarket[] = [];
    const pmEntries: UnmatchedMarket[] = [];
    const seenKalshi = new Set<string>();
    const seenPM = new Set<string>();

    // Collect from saved markets' last scan results
    for (const sm of savedMarkets) {
      if (sm.lastScanResult) {
        // Extract unmatched from scan result if available
        // We rebuild from the URLs since scan results don't store full unmatched lists
        if (sm.kalshiUrl) {
          const kId = sm.kalshiUrl.split('/').pop() || '';
          if (!seenKalshi.has(kId)) {
            seenKalshi.add(kId);
            kalshiEntries.push({
              platform: 'kalshi',
              title: sm.eventTitle,
              identifier: kId,
              expiryDate: sm.expiryDate || undefined,
              category: sm.category || undefined,
            });
          }
        }
        if (sm.polymarketUrl) {
          const pmId = extractPMConditionId(sm.polymarketUrl);
          if (pmId && !seenPM.has(pmId)) {
            seenPM.add(pmId);
            pmEntries.push({
              platform: 'polymarket',
              title: sm.eventTitle,
              identifier: pmId,
              expiryDate: sm.expiryDate || undefined,
              category: sm.category || undefined,
            });
          }
        }
      }
    }

    // Also collect from PredictionHunt markets
    for (const pm of phMarkets) {
      if (pm.kalshiUrl) {
        const kId = pm.kalshiUrl.split('/').pop() || '';
        if (!seenKalshi.has(kId)) {
          seenKalshi.add(kId);
          kalshiEntries.push({
            platform: 'kalshi',
            title: pm.title,
            identifier: kId,
            expiryDate: pm.eventDate || undefined,
            category: pm.eventType || undefined,
          });
        }
      }
      if (pm.polymarketUrl) {
        const pmId = extractPMConditionId(pm.polymarketUrl);
        if (pmId && !seenPM.has(pmId)) {
          seenPM.add(pmId);
          pmEntries.push({
            platform: 'polymarket',
            title: pm.title,
            identifier: pmId,
            expiryDate: pm.eventDate || undefined,
            category: pm.eventType || undefined,
          });
        }
      }
    }

    // Load rejections
    const rejections = await loadRejections();

    // Generate suggestions (engine returns top candidates)
    const suggestions = suggestCouplings(
      kalshiEntries,
      pmEntries,
      rejections,
    );

    // Count by match type
    const exactCount = suggestions.filter((s) => s.confidence >= 80).length;
    const looseCount = suggestions.filter(
      (s) => s.confidence >= 50 && s.confidence < 80,
    ).length;
    const correlatedCount = suggestions.filter((s) => s.confidence < 50).length;

    return NextResponse.json({
      kalshiMarkets: kalshiEntries.map(entryToMarketEntry).slice(offset, offset + clampedLimit),
      pmMarkets: pmEntries.map(entryToMarketEntry).slice(offset, offset + clampedLimit),
      suggestions: suggestions.slice(0, Math.min(maxSuggestions, 20)),
      pagination: {
        kalshiTotal: kalshiEntries.length,
        pmTotal: pmEntries.length,
        offset,
        limit: clampedLimit,
      },
      stats: {
        kalshiCount: kalshiEntries.length,
        pmCount: pmEntries.length,
        suggestionCount: suggestions.length,
        exactCount,
        looseCount,
        correlatedCount,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to fetch coupling data' },
      { status: 500 },
    );
  }
}

/* ─── POST /api/generous-coupling
 *
 * Accept or reject a coupling suggestion.
 * Body: { action: "accept" | "reject", kalshiId, pmId, reason? }
 * ══════════════════════════════════════════════════════════════════════ */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, kalshiId, pmId, reason } = body;

    const rejections = await loadRejections();

    if (action === 'reject') {
      const rejection: CouplingRejection = {
        kalshiTicker: kalshiId || '',
        pmConditionId: pmId || '',
        rejectedAt: new Date().toISOString(),
        reason,
      };
      rejections.push(rejection);
      await saveRejections(rejections);
      return NextResponse.json({ success: true, rejection });
    }

    if (action === 'accept') {
      // Remove from rejections if previously rejected
      const idx = rejections.findIndex(
        (r) => r.kalshiTicker === kalshiId && r.pmConditionId === pmId,
      );
      if (idx >= 0) {
        rejections.splice(idx, 1);
        await saveRejections(rejections);
      }

      // Optionally, save the pair as a manual match
      try {
        const { addManualMatch } = await import('@/lib/manual-matches');
        await addManualMatch({
          kalshiTicker: kalshiId,
          pmConditionId: pmId,
          kalshiTitle: '',
          pmTitle: '',
        });
      } catch {
        // Ignore — manual match creation is best-effort
      }

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to process action' },
      { status: 500 },
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function extractPMConditionId(url: string): string | null {
  const match = url.match(/\/event\/([^/?]+)/);
  return match ? match[1] : null;
}

async function loadRejections(): Promise<CouplingRejection[]> {
  const file = path.join(DATA_DIR, 'coupling-rejections.json');
  try {
    const data = await fs.readFile(file, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveRejections(rejections: CouplingRejection[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, 'coupling-rejections.json'),
    JSON.stringify(rejections, null, 2),
  );
}

interface MarketEntry {
  platform: 'kalshi' | 'polymarket';
  id: string;
  title: string;
  url: string;
  expiryDate?: string;
  category?: string;
}

function entryToMarketEntry(e: UnmatchedMarket): MarketEntry {
  return {
    platform: e.platform,
    id: e.identifier,
    title: e.title,
    url: e.platform === 'kalshi'
      ? `https://kalshi.com/markets/${e.identifier}`
      : `https://polymarket.com/event/${e.identifier}`,
    expiryDate: e.expiryDate,
    category: e.category,
  };
}
