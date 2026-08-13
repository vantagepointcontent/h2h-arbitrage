import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { getSavedMarkets, addSavedMarket, deleteSavedMarket, updateSavedMarket, getMarketUrlsById, reconcileSavedMarketMatchSummaries } from '@/lib/persistence';
import { persistAndConsumeBotScan } from '@/lib/bot-scan-consumer';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';
import { parseSavedMarketCreate, parseSavedMarketId, parseSavedMarketPatch } from '@/lib/saved-market-request';
import fs from 'fs/promises';
import path from 'path';

async function readSchedulerState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'saved-market-scheduler.json'), 'utf8'));
  } catch {
    return {};
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const fields = searchParams.get('fields') || 'full';
    const id = searchParams.get('id');

    await reconcileSavedMarketMatchSummaries();
    const [savedMarkets, schedulerState] = await Promise.all([getSavedMarkets(), readSchedulerState()]);
    const markets = savedMarkets.map(market => {
      const scheduler = schedulerState[market.id] as Record<string, unknown> | undefined;
      const scanAt = market.lastScanResult?.scannedAt;
      const scanSucceeded = market.lastScanResult?.matchStatus !== 'unavailable'
        && market.lastScanResult?.matchStatus !== 'refreshing';
      const schedulerSuccessAt = typeof scheduler?.lastSuccessAt === 'string' ? scheduler.lastSuccessAt : null;
      const lastSuccessAt = scanSucceeded && scanAt
        && (!schedulerSuccessAt || Date.parse(scanAt) > Date.parse(schedulerSuccessAt))
        ? scanAt
        : schedulerSuccessAt;
      return {
        ...market,
        scheduler: scheduler ? { ...scheduler, lastSuccessAt } : null,
      };
    });

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
      // Slim payload: only scalar fields the sidebar/overview need.
      // Full scan data comes from ?id= fetch when a market is selected.
      const basic = markets.map((m: any) => {
        const ls = m.lastScanResult;
        const allArbs = Array.isArray(ls?.allArbs) ? ls.allArbs : [];
        return {
          id: m.id,
          eventTitle: m.eventTitle,
          kalshiUrl: m.kalshiUrl,
          polymarketUrl: m.polymarketUrl,
          expiryDate: m.expiryDate,
          scheduler: m.scheduler,
          lastScanResult: ls ? {
            bestRoiPct: ls.bestRoiPct ?? 0,
            bestProfit: ls.bestProfit ?? 0,
            strategy: ls.strategy ?? '',
            scannedAt: ls.scannedAt ?? null,
            matchedCount: ls.matchedCount ?? 0,
            matchStatus: ls.matchStatus ?? (ls.scannedAt ? ((ls.matchedCount ?? 0) > 0 ? 'matched' : 'confirmed_zero') : 'not_scanned'),
            matchError: ls.matchError ?? null,
            matchedPairs: Array.isArray(ls.matchedPairs) ? ls.matchedPairs : [],
            // Minimal arb objects — only fields sidebar/cached view reads
            allArbs: allArbs.map((a: any) => ({
              artist: a.artist ?? '',
              roiPct: a.roiPct ?? 0,
              expectedProfit: a.expectedProfit ?? 0,
              strategy: a.strategy ?? '',
              kalshiTicker: a.kalshiTicker ?? null,
              pmConditionId: a.pmConditionId ?? null,
              kalshiYesAsk: a.kalshiYesAsk ?? null,
              kalshiNoAsk: a.kalshiNoAsk ?? null,
              pmYesPrice: a.pmYesPrice ?? null,
              pmNoPrice: a.pmNoPrice ?? null,
              kalshiStake: a.kalshiStake ?? null,
              pmStake: a.pmStake ?? null,
              totalStake: a.totalStake ?? a.maxCapital ?? null,
              fees: a.fees ? {
                kalshiFee: a.fees.kalshiFee ?? 0,
                polymarketFee: a.fees.polymarketFee ?? a.fees.pmFee ?? 0,
                totalFees: a.fees.totalFees ?? ((a.fees.kalshiFee ?? 0) + (a.fees.polymarketFee ?? a.fees.pmFee ?? 0)),
                worstCaseNetProfit: a.fees.worstCaseNetProfit ?? a.expectedProfit ?? 0,
              } : undefined,
            })),
          } : null,
          liveResult: m.liveResult ? {
            bestRoiPct: m.liveResult.bestRoiPct ?? 0,
            scannedAt: m.liveResult.scannedAt ?? null,
            matchedCount: m.liveResult.matchedCount ?? 0,
            matchStatus: m.liveResult.matchStatus ?? ((m.liveResult.matchedCount ?? 0) > 0 ? 'matched' : 'confirmed_zero'),
            matchError: m.liveResult.matchError ?? null,
            matchedPairs: Array.isArray(m.liveResult.matchedPairs) ? m.liveResult.matchedPairs : [],
            allArbs: Array.isArray(m.liveResult.allArbs)
              ? m.liveResult.allArbs.map((a: any) => ({
                  artist: a.artist ?? '',
                  roiPct: a.roiPct ?? 0,
                  expectedProfit: a.expectedProfit ?? 0,
                  strategy: a.strategy ?? '',
                  kalshiTicker: a.kalshiTicker ?? null,
                  pmConditionId: a.pmConditionId ?? null,
                  kalshiYesAsk: a.kalshiYesAsk ?? null,
                  kalshiNoAsk: a.kalshiNoAsk ?? null,
                  pmYesPrice: a.pmYesPrice ?? null,
                  pmNoPrice: a.pmNoPrice ?? null,
                  kalshiStake: a.kalshiStake ?? null,
                  pmStake: a.pmStake ?? null,
                  totalStake: a.totalStake ?? a.maxCapital ?? null,
                  fees: a.fees ? {
                    kalshiFee: a.fees.kalshiFee ?? 0,
                    polymarketFee: a.fees.polymarketFee ?? a.fees.pmFee ?? 0,
                    totalFees: a.fees.totalFees ?? ((a.fees.kalshiFee ?? 0) + (a.fees.polymarketFee ?? a.fees.pmFee ?? 0)),
                    worstCaseNetProfit: a.fees.worstCaseNetProfit ?? a.expectedProfit ?? 0,
                  } : undefined,
                }))
              : [],
          } : null,
        };
      });
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
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const body: any = parsed.body;
    const create = parseSavedMarketCreate(body);
    if ('error' in create) return NextResponse.json({ error: create.error }, { status: 400 });
    const market = await addSavedMarket({
      ...create,
    });

    // If the request also carried a scan result, persist it to SQLite
    if (body.scanResult) {
      try {
        const saved = await persistAndConsumeBotScan(market.id, {
          bestRoiPct: body.scanResult.bestRoiPct ?? 0,
          bestProfit: body.scanResult.bestProfit ?? 0,
          strategy: body.scanResult.strategy ?? '',
          outcomeCount: body.scanResult.outcomeCount ?? 0,
          matchedCount: body.scanResult.matchedCount ?? 0,
          kalshiCount: body.scanResult.kalshiCount ?? 0,
          pmCount: body.scanResult.pmCount ?? 0,
          scannedAt: body.scanResult.scannedAt ?? new Date().toISOString(),
          expiryAt: body.scanResult.expiryAt ?? body.scanResult.expiryDate ?? market.expiryDate ?? null,
          positiveArbCount: body.scanResult.positiveArbCount,
          totalStake: body.scanResult.totalStake,
          raw: body.scanResult.raw,
          marketTitle: market.eventTitle,
          kalshiUrl: body.kalshiUrl,
          polymarketUrl: body.polymarketUrl,
        }, 'scheduled');
        return NextResponse.json({ market, scanResultId: saved.id }, { status: 201 });
      } catch (scanErr: any) {
        // Non-fatal — market was still created
        console.warn('[saved-markets POST] scanResult save failed:', scanErr?.message);
      }
    }

    return NextResponse.json({ market }, { status: 201 });
  } catch (err: any) {
    if (err?.message?.startsWith('Market already exists')) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const update = parseSavedMarketPatch(parsed.body);
    if ('error' in update) return NextResponse.json({ error: update.error }, { status: 400 });
    const { id, ...changes } = update;
    const ok = await updateSavedMarket(id, {
      eventTitle: changes.eventTitle,
      expiryDate: changes.expiryDate,
      category: changes.category,
      kalshiUrl: changes.kalshiUrl,
      polymarketUrl: changes.polymarketUrl,
      platformLinks: changes.platformLinks,
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
    const id = parseSavedMarketId(searchParams.get('id'));
    if (!id) {
      return NextResponse.json({ error: 'Missing or invalid id query parameter' }, { status: 400 });
    }
    const ok = await deleteSavedMarket(id);
    return NextResponse.json({ success: ok });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
