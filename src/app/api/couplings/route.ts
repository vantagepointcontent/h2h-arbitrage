import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { suggestCouplings, CouplingCandidate, CouplingRejection, UnmatchedMarket } from '@/lib/coupling';

const DATA_DIR = path.join(process.cwd(), 'data');
const REJECTIONS_FILE = path.join(DATA_DIR, 'coupling-rejections.json');

async function loadRejections(): Promise<CouplingRejection[]> {
  try {
    const data = await fs.readFile(REJECTIONS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveRejections(rejections: CouplingRejection[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(REJECTIONS_FILE, JSON.stringify(rejections, null, 2));
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const kalshiTitles = url.searchParams.getAll('kalshi');
    const pmTitles = url.searchParams.getAll('pm');
    const kalshiTickers = url.searchParams.getAll('kalshi_ticker');
    const pmConditionIds = url.searchParams.getAll('pm_condition_id');
    const kalshiExpiries = url.searchParams.getAll('kalshi_expiry');
    const pmExpiries = url.searchParams.getAll('pm_expiry');
    const kalshiCategories = url.searchParams.getAll('kalshi_category');
    const pmCategories = url.searchParams.getAll('pm_category');

    // Build unmatched market objects from query params
    const kalshiMarkets: UnmatchedMarket[] = kalshiTickers.map((ticker, i) => ({
      platform: 'kalshi' as const,
      title: kalshiTitles[i] || '',
      identifier: ticker,
      expiryDate: kalshiExpiries[i] || undefined,
      category: kalshiCategories[i] || undefined,
    }));

    const pmMarkets: UnmatchedMarket[] = pmConditionIds.map((cid, i) => ({
      platform: 'polymarket' as const,
      title: pmTitles[i] || '',
      identifier: cid,
      expiryDate: pmExpiries[i] || undefined,
      category: pmCategories[i] || undefined,
    }));

    const rejections = await loadRejections();
    const suggestions = suggestCouplings(kalshiMarkets, pmMarkets, rejections);

    return NextResponse.json({ suggestions });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to generate suggestions' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, kalshiTicker, pmConditionId, reason } = body;

    const rejections = await loadRejections();

    if (action === 'reject') {
      const rejection: CouplingRejection = {
        kalshiTicker: kalshiTicker || '',
        pmConditionId: pmConditionId || '',
        rejectedAt: new Date().toISOString(),
        reason,
      };
      rejections.push(rejection);
      await saveRejections(rejections);

      return NextResponse.json({ success: true, rejection });
    }

    if (action === 'accept') {
      const idx = rejections.findIndex(
        r => r.kalshiTicker === kalshiTicker && r.pmConditionId === pmConditionId,
      );
      if (idx >= 0) {
        rejections.splice(idx, 1);
        await saveRejections(rejections);
      }

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to process coupling action' }, { status: 500 });
  }
}
