import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { getSavedMarkets, addSavedMarket, deleteSavedMarket, updateSavedMarket, saveScanResult, getMarketUrlsById } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const fields = searchParams.get('fields') || 'full';
    const id = searchParams.get('id');

    const markets = await getSavedMarkets();

    // Single full market by id — used by loadMarket() for instant-load allArbs
    if (id) {
      const market = markets.find((m: any) => m.id === id) ?? null;
      // Fallback: if market isn't in saved_markets (archived/never saved),
      // look up URLs from scan_results so the scan page can auto-rescan.
      if (!market) {
        const urls = await getMarketUrlsById(id);
        if (urls) {
          return NextResponse.json({ market: { id, kalshiUrl: urls.kalshiUrl, polymarketUrl: urls.polymarketUrl, eventTitle: '', fromScanResults: true } }, {
            headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' }
          });
        }
      }
      return NextResponse.json({ market }, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        }
      });
    }

    if (fields === 'basic') {
      // Slim payload: keep all scalar fields but reduce allArbs entries to
      // { expectedProfit } — the only field sidebar/overview read from the
      // blob (arb counts + profit totals). Full blobs come from ?id= fetch.
      const basic = markets.map((m: any) => ({
        ...m,
        lastScanResult: m.lastScanResult
          ? {
              ...m.lastScanResult,
              allArbs: Array.isArray(m.lastScanResult.allArbs)
                ? m.lastScanResult.allArbs.map((a: any) => ({ expectedProfit: a.expectedProfit ?? 0 }))
                : m.lastScanResult.allArbs,
            }
          : null,
      }));
      // PERF-P3: ETag/304 — the UI polls every 60s but poller tiers are
      // 5-30min, so most polls are unchanged. 304 skips the 370KB body.
      const body = JSON.stringify({ markets: basic });
      const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
      if (request.headers.get('if-none-match') === etag) {
        return new NextResponse(null, {
          status: 304,
          headers: { 'ETag': etag, 'Cache-Control': 'no-cache' },
        });
      }
      return new NextResponse(body, {
        headers: {
          'Content-Type': 'application/json',
          'ETag': etag,
          // no-cache (NOT no-store): browser revalidates with If-None-Match
          'Cache-Control': 'no-cache',
        }
      });
    }

    if (fields === 'names') {
      // Ultra-light: just {id, eventTitle} for lookups (~20KB for 500 markets)
      const names = markets.map((m: any) => ({ id: m.id, eventTitle: m.eventTitle }));
      return NextResponse.json({ markets: names }, {
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
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
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
          marketTitle: market.eventTitle,
          kalshiUrl: body.kalshiUrl,
          polymarketUrl: body.polymarketUrl,
        });
        return NextResponse.json({ market, scanResultId: saved.id }, { status: 201 });
      } catch (scanErr: any) {
        // Non-fatal — market was still created
        console.warn('[saved-markets POST] scanResult save failed:', scanErr?.message);
      }
    }

    return NextResponse.json({ market }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
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
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
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
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
