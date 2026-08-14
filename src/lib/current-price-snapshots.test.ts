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
      expect.objectContaining({ platform: 'kalshi', side: 'yes', priceCents: 44, executableDepthMicros: 2_000_000, failureReason: null }),
      expect.objectContaining({ platform: 'kalshi', side: 'no', priceCents: 45, executableDepthMicros: 500_000, failureReason: 'Kalshi NO executable depth 0.5 is below one share' }),
      expect.objectContaining({ platform: 'polymarket', side: 'no', tokenId: 'token-no', priceCents: 52, executableDepthMicros: 4_000_000, failureReason: null }),
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
    expect(result.get('kalshi|kx-exact|yes|')).toMatchObject({ status: 'stale', priceCents: 44, executableDepthMicros: 2_000_000, source: 'saved-market-full-scan' });
    expect(result.get('polymarket|0xexact|no|token-no')).toMatchObject({ status: 'stale', priceCents: 52, executableDepthMicros: 4_000_000 });
    expect(result.get('polymarket|0xexact|no|token-yes')).toMatchObject({ status: 'side_mismatch', priceCents: null });
    expect(result.get('kalshi|never|yes|')).toMatchObject({ status: 'never_saved', priceCents: null });
    expect(result.get('kalshi||yes|')).toMatchObject({ status: 'missing_identifier', priceCents: null });
    expect(snapshots.getCurrentPriceSnapshotMetrics()).toMatchObject({
      readBatches: 1, writeBatches: 2, lastRequestedLegs: 6, lastUniqueLegs: 5,
    });
  });

  it('preserves the newest exact executable quote through a newer temporary failure', async () => {
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
      status: 'stale', priceCents: 61, executableDepthMicros: 1_000_000,
      observedAt: '2026-08-14T12:00:00.000Z',
      failureReason: 'Polymarket YES executable depth 0.5 is below one share',
    });
  });
});
