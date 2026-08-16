import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DiskCapacityError,
  assertDiskCapacity,
  classifyDiskAlert,
  evaluateDiskCapacity,
  forecastDiskExhaustion,
} from './disk-capacity.mjs';

const created: string[] = [];

function snapshot(freeBytes: number, availableInodes = 1_000_000) {
  return {
    totalBytes: 80_000_000_000,
    freeBytes,
    totalInodes: 10_000_000,
    availableInodes,
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('disk capacity gates', () => {
  it('fails before an operation would consume reserved production headroom', () => {
    const result = evaluateDiskCapacity('build', snapshot(18_000_000_000), {
      reserveBytes: 15_000_000_000,
      burstBytes: 4_000_000_000,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/headroom/i);
    expect(result.projectedFreeBytes).toBe(14_000_000_000);
  });

  it('allows a bounded scan burst while preserving the reserve', () => {
    const result = evaluateDiskCapacity('scan', snapshot(16_000_000_000), {
      reserveBytes: 15_000_000_000,
      burstBytes: 128_000_000,
    });

    expect(result.allowed).toBe(true);
    expect(result.projectedFreeBytes).toBe(15_872_000_000);
  });

  it('fails safely when inode headroom is exhausted', () => {
    const result = evaluateDiskCapacity('backup', snapshot(40_000_000_000, 500), {
      reserveBytes: 15_000_000_000,
      burstBytes: 1_000_000_000,
      reserveInodes: 1_000,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/inode/i);
  });

  it('records allowed and blocked decisions as durable JSONL metrics', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'disk-capacity-'));
    created.push(dir);
    const metricsPath = path.join(dir, 'metrics.jsonl');

    await assertDiskCapacity('scan', {
      snapshot: snapshot(16_000_000_000),
      metricsPath,
      reserveBytes: 15_000_000_000,
      burstBytes: 128_000_000,
    });
    await expect(assertDiskCapacity('build', {
      snapshot: snapshot(18_000_000_000),
      metricsPath,
      reserveBytes: 15_000_000_000,
      burstBytes: 4_000_000_000,
    })).rejects.toBeInstanceOf(DiskCapacityError);

    const rows = (await readFile(metricsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.map((row) => row.allowed)).toEqual([true, false]);
    expect(rows[1]).toMatchObject({ operation: 'build', projectedFreeBytes: 14_000_000_000 });
  });

  it('forecasts exhaustion from observed growth and alerts before the reserve is breached', () => {
    const forecast = forecastDiskExhaustion([
      { at: '2026-08-15T00:00:00.000Z', usedBytes: 60_000_000_000, totalBytes: 80_000_000_000 },
      { at: '2026-08-16T00:00:00.000Z', usedBytes: 62_000_000_000, totalBytes: 80_000_000_000 },
    ], 15_000_000_000);

    expect(forecast).not.toBeNull();
    if (!forecast) throw new Error('expected forecast');
    expect(forecast.growthBytesPerDay).toBe(2_000_000_000);
    expect(forecast.daysUntilReserve).toBeCloseTo(1.5);
    expect(classifyDiskAlert({ usagePct: 77.5, inodeUsagePct: 10 }, forecast)).toBe('critical');
  });

  it('raises an emergency alert for byte or inode saturation', () => {
    expect(classifyDiskAlert({ usagePct: 95, inodeUsagePct: 10 }, null)).toBe('emergency');
    expect(classifyDiskAlert({ usagePct: 10, inodeUsagePct: 95 }, null)).toBe('emergency');
  });

  it('ignores short-term write noise when forecasting capacity', () => {
    expect(forecastDiskExhaustion([
      { at: '2026-08-16T00:00:00.000Z', usedBytes: 60_000_000_000, totalBytes: 80_000_000_000 },
      { at: '2026-08-16T00:10:00.000Z', usedBytes: 61_000_000_000, totalBytes: 80_000_000_000 },
    ], 15_000_000_000)).toBeNull();
  });
});
