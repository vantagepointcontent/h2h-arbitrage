import { describe, expect, it } from 'vitest';
import { buildArbTimingHeatmap, isTrustworthyTimingEpisode } from './arb-timing';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');

function episode(overrides: Record<string, unknown> = {}) {
  return {
    first_seen_at: '2026-08-03T13:15:00.000Z', // Monday 09:15 US Eastern
    category: 'Sports',
    status: 'closed',
    duration_sec: 90,
    scan_count: 3,
    peak_roi_pct: 1.2,
    ...overrides,
  };
}

describe('arb timing heatmap', () => {
  it('counts distinct trustworthy episodes by US Eastern weekday and hour', () => {
    const result = buildArbTimingHeatmap([
      episode(),
      episode({ first_seen_at: '2026-08-03T13:59:00.000Z' }),
    ], { nowMs: NOW });

    expect(result.totalEpisodes).toBe(2);
    expect(result.cells.find((cell) => cell.day === 0 && cell.hour === 9)?.count).toBe(2);
  });

  it('excludes one-scan and short-lived phantom opportunities', () => {
    const result = buildArbTimingHeatmap([
      episode({ scan_count: 1 }),
      episode({ duration_sec: 29 }),
      episode({ peak_roi_pct: 0 }),
      episode(),
    ], { nowMs: NOW });

    expect(result.totalEpisodes).toBe(1);
  });

  it('filters by category and supports UTC bucketing', () => {
    const result = buildArbTimingHeatmap([
      episode(),
      episode({ category: 'Politics' }),
    ], { category: 'Sports', timeZone: 'UTC', nowMs: NOW });

    expect(result.totalEpisodes).toBe(1);
    expect(result.cells.find((cell) => cell.day === 0 && cell.hour === 13)?.count).toBe(1);
    expect(result.categories).toEqual(['Politics', 'Sports']);
  });

  it('accepts open episodes only after they have persisted for 30 seconds', () => {
    expect(isTrustworthyTimingEpisode(episode({ status: 'open', duration_sec: null, first_seen_at: '2026-08-08T11:59:31.000Z' }), NOW)).toBe(false);
    expect(isTrustworthyTimingEpisode(episode({ status: 'open', duration_sec: null, first_seen_at: '2026-08-08T11:59:29.000Z' }), NOW)).toBe(true);
  });
});
