import { describe, expect, it } from 'vitest';
import { planArtifactRetention } from './artifact-retention.mjs';

describe('artifact retention', () => {
  it('deletes only delivered artifacts after their retention window', () => {
    const plan = planArtifactRetention([
      { name: 'old-delivered.json', modifiedAtMs: 1, delivered: true },
      { name: 'old-undelivered.json', modifiedAtMs: 1, delivered: false },
      { name: 'new-delivered.json', modifiedAtMs: 100 },
    ], { now: 100, maxAgeMs: 50 });

    expect(plan.delete.map((item: { name: string }) => item.name)).toEqual(['old-delivered.json']);
    expect(plan.keep.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(['old-undelivered.json', 'new-delivered.json']));
  });
});
