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
      kalshi: { ticker: 'KX-EXACT', yesAsk: 0.47, noAsk: 0.54 },
      polymarket: { conditionId: '0xEXACT', yesPrice: 0.46, noPrice: 0.55, yesTokenId: 'token-yes', noTokenId: 'token-no' },
    } as unknown as UnifiedOutcome;
    const initial = snapshots.snapshotInputsFromOutcomes([outcome], { kalshi: newer, polymarket: newer }, 'saved-market-full-scan');
    expect(initial).toHaveLength(4);
    expect((await snapshots.persistPlatformPriceSnapshots(initial)).applied).toBe(4);

    const staleWrite = snapshots.snapshotInputsFromOutcomes([{
      ...outcome,
      kalshi: { ...outcome.kalshi, yesAsk: 0.11 },
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
    expect(result.get('kalshi|kx-exact|yes|')).toMatchObject({ status: 'stale', priceCents: 47, source: 'saved-market-full-scan' });
    expect(result.get('polymarket|0xexact|no|token-no')).toMatchObject({ status: 'stale', priceCents: 55 });
    expect(result.get('polymarket|0xexact|no|token-yes')).toMatchObject({ status: 'side_mismatch', priceCents: null });
    expect(result.get('kalshi|never|yes|')).toMatchObject({ status: 'never_saved', priceCents: null });
    expect(result.get('kalshi||yes|')).toMatchObject({ status: 'missing_identifier', priceCents: null });
    expect(snapshots.getCurrentPriceSnapshotMetrics()).toMatchObject({
      readBatches: 1, writeBatches: 2, lastRequestedLegs: 6, lastUniqueLegs: 5,
    });
  });
});
