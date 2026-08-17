import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedOutcome } from './matcher';

let tempDir: string | null = null;

afterEach(() => {
  delete process.env.H2H_SQLITE_PATH;
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('persisted current-price snapshots', () => {
  it('persists full-precision indicative scan prices independently of executable depth', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indicative-price-snapshots-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'snapshots.db');
    const snapshots = await import('./current-price-snapshots');
    const observedAt = '2026-08-17T12:00:00.000Z';
    const outcome = {
      kalshi: {
        ticker: 'KX-INDICATIVE', yesAsk: 0.455_001, noAsk: 0.544_999,
        yesBid: null, noBid: 0.44, yesBidDepth: null, noBidDepth: '0.25',
      },
      polymarket: {
        conditionId: '0xINDICATIVE', yesPrice: 0.544_499, noPrice: 0.455_501,
        yesTokenId: 'token-yes', noTokenId: 'token-no',
        yesBid: null, noBid: 0.44, yesBidDepth: null, noBidDepth: 0.25,
      },
    } as unknown as UnifiedOutcome;

    const inputs = snapshots.snapshotInputsFromOutcomes(
      [outcome],
      { kalshi: observedAt, polymarket: observedAt },
      'saved-market-full-scan',
    );
    expect(inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: 'kalshi', side: 'yes', priceMicrocents: 45_500_100,
        priceCents: 46, executableDepthMicros: null,
      }),
      expect.objectContaining({
        platform: 'polymarket', side: 'yes', tokenId: 'token-yes',
        priceMicrocents: 54_449_900, priceCents: 54, executableDepthMicros: null,
      }),
    ]));
    await snapshots.persistPlatformPriceSnapshots(inputs);

    const result = await snapshots.getPersistedCurrentPriceBatch([
      { platform: 'kalshi', marketId: 'KX-INDICATIVE', side: 'yes', tokenId: null },
      { platform: 'polymarket', marketId: '0xINDICATIVE', side: 'yes', tokenId: 'token-yes' },
    ], Date.parse('2026-08-17T12:16:00.000Z'));
    expect(result.get('kalshi|kx-indicative|yes|')).toMatchObject({
      status: 'stale', priceMicrocents: 45_500_100, priceCents: 46,
    });
    expect(result.get('polymarket|0xindicative|yes|token-yes')).toMatchObject({
      status: 'stale', priceMicrocents: 54_449_900, priceCents: 54,
    });
  });

  it('requires both the exact Polymarket parent and exact held token', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-price-snapshots-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'snapshots.db');
    const snapshots = await import('./current-price-snapshots');
    await snapshots.persistPlatformPriceSnapshots([{
      platform: 'polymarket', marketId: '0xparent-a', side: 'no', tokenId: 'shared-token',
      priceCents: 52, priceMicrocents: 52_000_000, executableDepthMicros: 1_000_000,
      failureReason: null, source: 'saved-market-full-scan', observedAt: '2026-08-17T12:00:00.000Z',
    }]);

    const result = await snapshots.getPersistedCurrentPriceBatch([{
      platform: 'polymarket', marketId: '0xparent-b', side: 'no', tokenId: 'shared-token',
    }]);
    expect(result.get('polymarket|0xparent-b|no|shared-token')).toMatchObject({
      status: 'never_saved', priceCents: null,
    });
  });

  it('does not let a tokenless Polymarket scan replace a token-bound mark', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-price-snapshots-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'snapshots.db');
    const snapshots = await import('./current-price-snapshots');
    await snapshots.persistPlatformPriceSnapshots([{
      platform: 'polymarket', marketId: '0xparent', side: 'yes', tokenId: 'token-a',
      priceCents: 40, priceMicrocents: 40_000_000, executableDepthMicros: 1_000_000,
      failureReason: null, source: 'saved-market-full-scan', observedAt: '2026-08-17T12:00:00.000Z',
    }, {
      platform: 'polymarket', marketId: '0xparent', side: 'yes', tokenId: null,
      priceCents: 90, priceMicrocents: 90_000_000, executableDepthMicros: 1_000_000,
      failureReason: null, source: 'saved-market-quick-refresh', observedAt: '2026-08-17T12:01:00.000Z',
    }]);

    const result = await snapshots.getPersistedCurrentPriceBatch([{
      platform: 'polymarket', marketId: '0xparent', side: 'yes', tokenId: 'token-a',
    }], Date.parse('2026-08-17T12:02:00.000Z'));
    expect(result.get('polymarket|0xparent|yes|token-a')).toMatchObject({
      status: 'stale', priceCents: 40, priceMicrocents: 40_000_000,
      markFailureReason: 'Polymarket exact outcome token unavailable',
    });
  });

  it('deduplicates exact legs, fences out-of-order writes, and preserves precise states', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-price-snapshots-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'snapshots.db');
    const snapshots = await import('./current-price-snapshots');
    const newer = '2026-08-14T12:00:00.000Z';
    const older = '2026-08-14T11:00:00.000Z';

    const outcome = {
      kalshi: {
        ticker: 'KX-EXACT', yesAsk: 0.47, noAsk: 0.54,
        yesBid: 0.44, noBid: 0.45, yesBidDepth: '2', noBidDepth: '0.5',
      },
      polymarket: {
        conditionId: '0xEXACT', yesPrice: 0.46, noPrice: 0.55,
        yesTokenId: 'token-yes', noTokenId: 'token-no',
        yesBid: 0.43, noBid: 0.52, yesBidDepth: 3, noBidDepth: 4,
      },
    } as unknown as UnifiedOutcome;
    const initial = snapshots.snapshotInputsFromOutcomes([outcome], { kalshi: newer, polymarket: newer }, 'saved-market-full-scan');
    expect(initial).toHaveLength(4);
    expect(initial).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'kalshi', side: 'yes', priceCents: 47, priceMicrocents: 47_000_000, executableDepthMicros: 2_000_000, failureReason: null }),
      expect.objectContaining({ platform: 'kalshi', side: 'no', priceCents: 54, priceMicrocents: 54_000_000, executableDepthMicros: 500_000, failureReason: 'Kalshi NO executable depth 0.5 is below one share' }),
      expect.objectContaining({ platform: 'polymarket', side: 'no', tokenId: 'token-no', priceCents: 55, priceMicrocents: 55_000_000, executableDepthMicros: 4_000_000, failureReason: null }),
    ]));
    expect((await snapshots.persistPlatformPriceSnapshots(initial)).applied).toBe(4);

    const staleWrite = snapshots.snapshotInputsFromOutcomes([{
      ...outcome,
      kalshi: { ...outcome.kalshi, yesAsk: 0.11, yesBid: 0.11 },
    } as never], { kalshi: older, polymarket: older }, 'saved-market-quick-refresh');
    expect((await snapshots.persistPlatformPriceSnapshots(staleWrite)).applied).toBe(0);

    const requests = [
      { platform: 'kalshi', marketId: 'kx-exact', side: 'yes', tokenId: null },
      { platform: 'kalshi', marketId: 'KX-EXACT', side: 'yes', tokenId: null },
      { platform: 'polymarket', marketId: '0xexact', side: 'no', tokenId: 'token-no' },
      { platform: 'polymarket', marketId: '0xexact', side: 'no', tokenId: 'token-yes' },
      { platform: 'kalshi', marketId: 'never', side: 'yes', tokenId: null },
      { platform: 'kalshi', marketId: null, side: 'yes', tokenId: null },
    ] as const;
    const result = await snapshots.getPersistedCurrentPriceBatch([...requests], Date.parse('2026-08-14T12:16:00.000Z'));

    expect(result.size).toBe(5);
    expect(result.get('kalshi|kx-exact|yes|')).toMatchObject({ status: 'stale', priceCents: 47, priceMicrocents: 47_000_000, executableDepthMicros: 2_000_000, source: 'saved-market-full-scan' });
    expect(result.get('polymarket|0xexact|no|token-no')).toMatchObject({ status: 'stale', priceCents: 55, priceMicrocents: 55_000_000, executableDepthMicros: 4_000_000 });
    expect(result.get('polymarket|0xexact|no|token-yes')).toMatchObject({ status: 'side_mismatch', priceCents: null });
    expect(result.get('kalshi|never|yes|')).toMatchObject({ status: 'never_saved', priceCents: null });
    expect(result.get('kalshi||yes|')).toMatchObject({ status: 'missing_identifier', priceCents: null });
    expect(snapshots.getCurrentPriceSnapshotMetrics()).toMatchObject({
      readBatches: 1, writeBatches: 2, lastRequestedLegs: 6, lastUniqueLegs: 5,
    });
  });

  it('keeps the newer-started publication authoritative when an older refresh completes last', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-fenced-price-snapshots-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'snapshots.db');
    const snapshots = await import('./current-price-snapshots');

    let releaseOlder!: () => void;
    let releaseNewer!: () => void;
    const olderCompleted = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const newerCompleted = new Promise<void>((resolve) => { releaseNewer = resolve; });
    const older = (async () => {
      await olderCompleted;
      return snapshots.persistPlatformPriceSnapshots([{
        platform: 'polymarket', marketId: '0xoverlap', side: 'yes', tokenId: 'token-overlap',
        priceCents: 41, priceMicrocents: 41_000_000, executableDepthMicros: null,
        failureReason: 'older refresh warning', markFailureReason: 'older mark warning',
        source: 'saved-market-quick-refresh', observedAt: '2026-08-17T12:02:00.000Z',
        attemptedAt: '2026-08-17T12:00:00.000Z', publicationGeneration: 11,
        publicationScope: 'saved-overlap',
      }]);
    })();
    const newer = (async () => {
      await newerCompleted;
      return snapshots.persistPlatformPriceSnapshots([{
        platform: 'polymarket', marketId: '0xoverlap', side: 'yes', tokenId: 'token-overlap',
        priceCents: 63, priceMicrocents: 63_000_000, executableDepthMicros: 2_000_000,
        failureReason: 'newer refresh warning', markFailureReason: 'newer mark warning',
        source: 'saved-market-quick-refresh', observedAt: '2026-08-17T12:01:00.000Z',
        attemptedAt: '2026-08-17T12:00:01.000Z', publicationGeneration: 12,
        publicationScope: 'saved-overlap',
      }]);
    })();

    releaseNewer();
    expect((await newer).applied).toBe(1);
    releaseOlder();
    expect((await older).applied).toBe(0);

    const result = await snapshots.getPersistedCurrentPriceBatch([{
      platform: 'polymarket', marketId: '0xoverlap', side: 'yes', tokenId: 'token-overlap',
    }], Date.parse('2026-08-17T12:03:00.000Z'));
    expect(result.get('polymarket|0xoverlap|yes|token-overlap')).toMatchObject({
      status: 'available', priceCents: 63, priceMicrocents: 63_000_000,
      observedAt: '2026-08-17T12:01:00.000Z', executableDepthMicros: 2_000_000,
      failureReason: 'newer refresh warning', markFailureReason: 'newer mark warning',
    });
  });

  it('updates the indicative mark even when newer executable depth is insufficient', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-price-snapshots-fallback-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'snapshots.db');
    const snapshots = await import('./current-price-snapshots');
    await snapshots.persistPlatformPriceSnapshots([{
      platform: 'polymarket', marketId: '0xparent', side: 'yes', tokenId: 'exact-token',
      priceCents: 61, executableDepthMicros: 1_000_000, failureReason: null,
      source: 'saved-market-full-scan', observedAt: '2026-08-14T12:00:00.000Z',
    }]);
    await snapshots.persistPlatformPriceSnapshots([{
      platform: 'polymarket', marketId: '0xparent', side: 'yes', tokenId: 'exact-token',
      priceCents: 11, executableDepthMicros: 500_000, failureReason: 'Polymarket YES executable depth 0.5 is below one share',
      source: 'saved-market-quick-refresh', observedAt: '2026-08-14T12:01:00.000Z',
    }]);

    const result = await snapshots.getPersistedCurrentPriceBatch([{
      platform: 'polymarket', marketId: '0xparent', side: 'yes', tokenId: 'exact-token',
    }], Date.parse('2026-08-14T12:02:00.000Z'));
    expect(result.get('polymarket|0xparent|yes|exact-token')).toMatchObject({
      status: 'available', priceCents: 11, priceMicrocents: 11_000_000, executableDepthMicros: 500_000,
      observedAt: '2026-08-14T12:01:00.000Z',
      failureReason: 'Polymarket YES executable depth 0.5 is below one share',
    });
  });

  it('retains the latest known mark but marks it stale immediately after a newer scan has no indicative price', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-price-snapshots-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'snapshots.db');
    const snapshots = await import('./current-price-snapshots');
    await snapshots.persistPlatformPriceSnapshots([{
      platform: 'kalshi', marketId: 'KX-RETAIN', side: 'yes', tokenId: null,
      priceCents: 61, priceMicrocents: 61_000_000, executableDepthMicros: 1_000_000,
      failureReason: null, markFailureReason: null,
      source: 'saved-market-full-scan', observedAt: '2026-08-17T12:00:00.000Z',
    }]);
    await snapshots.persistPlatformPriceSnapshots([{
      platform: 'kalshi', marketId: 'KX-RETAIN', side: 'yes', tokenId: null,
      priceCents: null, priceMicrocents: null, executableDepthMicros: 1_000_000,
      failureReason: null, markFailureReason: 'Kalshi YES last-scanned price unavailable',
      source: 'saved-market-quick-refresh', observedAt: '2026-08-17T12:01:00.000Z',
    }]);

    const result = await snapshots.getPersistedCurrentPriceBatch([{
      platform: 'kalshi', marketId: 'KX-RETAIN', side: 'yes', tokenId: null,
    }], Date.parse('2026-08-17T12:02:00.000Z'));
    expect(result.get('kalshi|kx-retain|yes|')).toMatchObject({
      status: 'stale', priceCents: 61, priceMicrocents: 61_000_000,
      observedAt: '2026-08-17T12:00:00.000Z',
      markFailureReason: 'Kalshi YES last-scanned price unavailable',
    });
  });
});
