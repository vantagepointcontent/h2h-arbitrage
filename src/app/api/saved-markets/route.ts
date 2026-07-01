import { NextRequest, NextResponse } from 'next/server';
import { getSavedMarkets, addSavedMarket, deleteSavedMarket, updateSavedMarket, saveScanResult } from '@/lib/persistence';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const fields = searchParams.get('fields') || 'full';

    const markets = await getSavedMarkets();

    if (fields === 'basic') {
      // Strip lastScanResult.allArbs to reduce payload from 490KB → ~180KB
      const slim = markets.map((m: any) => {
        if (m.lastScanResult) {
          return {
            ...m,
            lastScanResult: {
              bestRoiPct: m.lastScanResult.bestRoiPct,
              bestProfit: m.lastScanResult.bestProfit,
              strategy: m.lastScanResult.strategy,
              outcomeCount: m.lastScanResult.outcomeCount,
              matchedCount: m.lastScanResult.matchedCount,
              kalshiCount: m.lastScanResult.kalshiCount,
              pmCount: m.lastScanResult.pmCount,
              scannedAt: m.lastScanResult.scannedAt,
              positiveArbCount: m.lastScanResult.positiveArbCount,
              totalStake: m.lastScanResult.totalStake,
            },
          };
        }
        return m;
      });
      return NextResponse.json({ markets: slim }, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        }
      });
    }

    return NextResponse.json({ markets }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      }
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.kalshiUrl || !body.polymarketUrl) {
      return NextResponse.json({ error: 'Missing kalshiUrl or polymarketUrl' }, { status: 400 });
    }
    const market = await addSavedMarket({
      kalshiUrl: body.kalshiUrl,
      polymarketUrl: body.polymarketUrl,
      eventTitle: body.eventTitle || 'Untitled',
      category: body.category || '',
      expiryDate: body.expiryDate || null,
    });

    // If the request also carried a scan result, persist it to SQLite
    if (body.scanResult) {
      try {
        const saved = await saveScanResult(market.id, {
          bestRoiPct: body.scanResult.bestRoiPct ?? 0,
          bestProfit: body.scanResult.bestProfit ?? 0,
          strategy: body.scanResult.strategy ?? '',
          outcomeCount: body.scanResult.outcomeCount ?? 0,
          matchedCount: body.scanResult.matchedCount ?? 0,
          kalshiCount: body.scanResult.kalshiCount ?? 0,
          pmCount: body.scanResult.pmCount ?? 0,
          scannedAt: body.scanResult.scannedAt ?? new Date().toISOString(),
          positiveArbCount: body.scanResult.positiveArbCount,
          totalStake: body.scanResult.totalStake,
          raw: body.scanResult.raw,
        });
        return NextResponse.json({ market, scanResultId: saved.id }, { status: 201 });
      } catch (scanErr: any) {
        // Non-fatal — market was still created
        console.warn('[saved-markets POST] scanResult save failed:', scanErr?.message);
      }
    }

    return NextResponse.json({ market }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }
    const ok = await updateSavedMarket(body.id, {
      eventTitle: body.eventTitle,
      expiryDate: body.expiryDate,
      category: body.category,
    });
    if (!ok) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing id query parameter' }, { status: 400 });
    }
    const ok = await deleteSavedMarket(id);
    return NextResponse.json({ success: ok });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
