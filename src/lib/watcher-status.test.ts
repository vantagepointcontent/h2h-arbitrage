// WS-106: Unit tests for watcher-status helpers — status classification,
// msg-rate derivation, tick freshness, HOT pair set extraction.

import { describe, it, expect } from 'vitest';
import {
  classifyWatcherStatus,
  parseConnectionRatio,
  computeMsgRate,
  tickFreshness,
  formatAge,
  freshnessColor,
  statusPillClasses,
  hotPairIdSet,
  type WatcherHealthPayload,
} from './watcher-status';

const NOW = Date.parse('2026-07-03T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('classifyWatcherStatus', () => {
  const base: WatcherHealthPayload = {
    status: 'ok',
    kalshiConnected: true,
    pmConnections: '1/1',
    integrity: { degraded: false },
  };

  it('null/undefined payload → down', () => {
    expect(classifyWatcherStatus(null)).toBe('down');
    expect(classifyWatcherStatus(undefined)).toBe('down');
    expect(classifyWatcherStatus({})).toBe('down');
  });

  it('explicit down/stalled pass through', () => {
    expect(classifyWatcherStatus({ status: 'down' })).toBe('down');
    expect(classifyWatcherStatus({ status: 'stalled' })).toBe('stalled');
  });

  it('healthy payload → ok', () => {
    expect(classifyWatcherStatus(base)).toBe('ok');
  });

  it('integrity.degraded overrides ok', () => {
    expect(classifyWatcherStatus({ ...base, integrity: { degraded: true } })).toBe('degraded');
  });

  it('kalshi disconnected → degraded', () => {
    expect(classifyWatcherStatus({ ...base, kalshiConnected: false })).toBe('degraded');
  });

  it('partial PM connections → degraded', () => {
    expect(classifyWatcherStatus({ ...base, pmConnections: '0/1' })).toBe('degraded');
    expect(classifyWatcherStatus({ ...base, pmConnections: '1/2' })).toBe('degraded');
  });

  it('stalled wins over degraded integrity', () => {
    expect(classifyWatcherStatus({ status: 'stalled', integrity: { degraded: true } })).toBe('stalled');
  });

  it('unparseable pmConnections does not degrade', () => {
    expect(classifyWatcherStatus({ ...base, pmConnections: 'weird' })).toBe('ok');
  });
});

describe('parseConnectionRatio', () => {
  it('parses "1/1" and "3/5"', () => {
    expect(parseConnectionRatio('1/1')).toEqual({ connected: 1, total: 1 });
    expect(parseConnectionRatio('3/5')).toEqual({ connected: 3, total: 5 });
  });
  it('tolerates spaces', () => {
    expect(parseConnectionRatio('2 / 4')).toEqual({ connected: 2, total: 4 });
  });
  it('returns null for junk', () => {
    expect(parseConnectionRatio(undefined)).toBeNull();
    expect(parseConnectionRatio(null)).toBeNull();
    expect(parseConnectionRatio('')).toBeNull();
    expect(parseConnectionRatio('abc')).toBeNull();
    expect(parseConnectionRatio('1/')).toBeNull();
    expect(parseConnectionRatio('-1/2')).toBeNull();
  });
});

describe('computeMsgRate', () => {
  it('computes msgs/sec across a 15s window', () => {
    const prev = { msgCount: 1000, ts: iso(0) };
    const curr = { msgCount: 1300, ts: iso(15_000) };
    expect(computeMsgRate(prev, curr)).toBe(20);
  });

  it('rounds to 1 decimal', () => {
    const prev = { msgCount: 0, ts: iso(0) };
    const curr = { msgCount: 100, ts: iso(30_000) };
    expect(computeMsgRate(prev, curr)).toBe(3.3);
  });

  it('null on first sample (no prev)', () => {
    expect(computeMsgRate(null, { msgCount: 5, ts: iso(0) })).toBeNull();
  });

  it('null on counter reset (watcher restart)', () => {
    const prev = { msgCount: 5000, ts: iso(0) };
    const curr = { msgCount: 12, ts: iso(15_000) };
    expect(computeMsgRate(prev, curr)).toBeNull();
  });

  it('null on zero/negative time delta or missing fields', () => {
    const prev = { msgCount: 10, ts: iso(0) };
    expect(computeMsgRate(prev, { msgCount: 20, ts: iso(0) })).toBeNull();
    expect(computeMsgRate(prev, { msgCount: 20, ts: iso(-1000) })).toBeNull();
    expect(computeMsgRate(prev, {})).toBeNull();
    expect(computeMsgRate(prev, null)).toBeNull();
    expect(computeMsgRate(prev, { msgCount: 20, ts: 'not-a-date' })).toBeNull();
  });

  it('zero rate when no new messages', () => {
    const prev = { msgCount: 100, ts: iso(0) };
    const curr = { msgCount: 100, ts: iso(15_000) };
    expect(computeMsgRate(prev, curr)).toBe(0);
  });
});

describe('tickFreshness', () => {
  it('live under 30s', () => {
    const f = tickFreshness(iso(-10_000), NOW);
    expect(f.level).toBe('live');
    expect(f.label).toBe('10s ago');
    expect(f.ageMs).toBe(10_000);
  });

  it('recent between 30s and 5m', () => {
    expect(tickFreshness(iso(-31_000), NOW).level).toBe('recent');
    expect(tickFreshness(iso(-4 * 60_000), NOW).level).toBe('recent');
  });

  it('stale between 5m and 1h', () => {
    expect(tickFreshness(iso(-6 * 60_000), NOW).level).toBe('stale');
    expect(tickFreshness(iso(-59 * 60_000), NOW).level).toBe('stale');
  });

  it('dead beyond 1h', () => {
    expect(tickFreshness(iso(-2 * 3600_000), NOW).level).toBe('dead');
  });

  it('never for missing/invalid timestamps', () => {
    expect(tickFreshness(null, NOW).level).toBe('never');
    expect(tickFreshness(undefined, NOW).level).toBe('never');
    expect(tickFreshness('garbage', NOW).level).toBe('never');
    expect(tickFreshness('', NOW).level).toBe('never');
  });

  it('future timestamps clamp to 0 age (clock skew safe)', () => {
    const f = tickFreshness(iso(5_000), NOW);
    expect(f.level).toBe('live');
    expect(f.ageMs).toBe(0);
  });

  it('boundary: exactly 30s is recent, not live', () => {
    expect(tickFreshness(iso(-30_000), NOW).level).toBe('recent');
  });
});

describe('formatAge', () => {
  it('formats seconds/minutes/hours/days', () => {
    expect(formatAge(5_000)).toBe('5s ago');
    expect(formatAge(90_000)).toBe('2m ago');   // rounds 1.5m → 2m
    expect(formatAge(3 * 3600_000)).toBe('3h ago');
    expect(formatAge(48 * 3600_000)).toBe('2d ago');
  });
  it('negative clamps to 0s', () => {
    expect(formatAge(-500)).toBe('0s ago');
  });
});

describe('color/class maps are total', () => {
  it('freshnessColor covers all levels', () => {
    for (const l of ['live', 'recent', 'stale', 'dead', 'never'] as const) {
      expect(freshnessColor(l)).toMatch(/^text-/);
    }
  });
  it('statusPillClasses covers all levels', () => {
    for (const l of ['ok', 'degraded', 'stalled', 'down'] as const) {
      expect(statusPillClasses(l)).toContain('bg-');
    }
  });
});

describe('hotPairIdSet', () => {
  it('extracts hot pair ids only', () => {
    const set = hotPairIdSet([
      { pairId: 'a', tier: 'hot' },
      { pairId: 'b', tier: 'warm' },
      { pairId: 'c', tier: 'hot' },
    ]);
    expect(set).toEqual(new Set(['a', 'c']));
  });
  it('tolerates malformed input', () => {
    expect(hotPairIdSet(null).size).toBe(0);
    expect(hotPairIdSet(undefined).size).toBe(0);
    expect(hotPairIdSet('nope').size).toBe(0);
    expect(hotPairIdSet([null, 42, { tier: 'hot' }, { pairId: 7, tier: 'hot' }]).size).toBe(0);
  });
});
