import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as store from './bundled-match-store';

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2h-bundles-'));
  fs.mkdirSync(path.join(tmpDir, 'data'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(os.tmpdir());
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const input = (name: string) => ({
  name, budgetCents: 10_000,
  targetRange: { minBps: null, minInclusive: false, maxBps: null, maxInclusive: false },
  legs: [
    { id: `${name}-a`, platform: 'kalshi' as const, marketId: `${name}-K`, title: 'Under 20', originalSide: 'yes' as const, orientation: 'same' as const, priceCents: 40, payoutCents: 100, feeBps: 0, quantityStep: 1, minimumQuantity: 1, maximumQuantity: 1000, range: { minBps: null, minInclusive: false, maxBps: 2000, maxInclusive: false } },
    { id: `${name}-b`, platform: 'polymarket' as const, marketId: `${name}-P`, title: 'At least 20', originalSide: 'no' as const, orientation: 'inverted' as const, priceCents: 45, payoutCents: 100, feeBps: 0, quantityStep: 1, minimumQuantity: 1, maximumQuantity: 1000, range: { minBps: 2000, minInclusive: true, maxBps: null, maxInclusive: false } },
  ],
});

describe('bundled match persistence', () => {
  it('creates, reads, updates, and removes a logical bundle retaining legs and orientation', async () => {
    const created = await store.addBundledMatch(input('one'));
    expect((await store.getBundledMatches())[0].legs[1].orientation).toBe('inverted');
    const updated = await store.updateBundledMatch(created.id, { ...input('edited'), budgetCents: 20_000 });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.budgetCents).toBe(20_000);
    expect(await store.deleteBundledMatch(created.id)).toBe(true);
    expect(await store.getBundledMatches()).toEqual([]);
  });

  it('serializes concurrent creates so none are lost', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, index) => store.addBundledMatch(input(`bundle-${index}`))));
    expect(await store.getBundledMatches()).toHaveLength(10);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'bundled-matches.json'), 'utf8'))).toHaveLength(10);
  });
});
