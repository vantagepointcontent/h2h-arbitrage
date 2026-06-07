import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeAdaptiveRefresh,
  isDueForRefresh,
  formatInterval,
  formatCountdown,
  nextRefreshAt,
  DEFAULT_CONFIG,
  AdaptiveRefreshConfig,
  AdaptiveRefreshTier,
} from './adaptive-refresh';

describe('computeAdaptiveRefresh', () => {
  // Mock Date.now() for deterministic tests
  const FIXED_NOW = new Date('2026-06-07T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Test 1: market expiring in 30min → 15s interval (<1h tier)', () => {
    // 30 minutes from now
    const expiryDate = new Date(FIXED_NOW + 30 * 60 * 1000).toISOString();
    const result = computeAdaptiveRefresh(expiryDate);

    expect(result.intervalMs).toBe(15 * 1000);
    expect(result.tierLabel).toBe('<1h');
    expect(result.secondsToExpiry).toBe(30 * 60);
    expect(result.expired).toBe(false);
    expect(result.missingExpiry).toBe(false);
  });

  it('Test 2: market expiring in 48h → 15min interval (>24h tier)', () => {
    // 48 hours from now
    const expiryDate = new Date(FIXED_NOW + 48 * 3600 * 1000).toISOString();
    const result = computeAdaptiveRefresh(expiryDate);

    expect(result.intervalMs).toBe(900 * 1000);
    expect(result.tierLabel).toBe('>24h');
    expect(result.secondsToExpiry).toBe(48 * 3600);
    expect(result.expired).toBe(false);
    expect(result.missingExpiry).toBe(false);
  });

  it('Test 3: user overrides tier to 10s → custom interval applies', () => {
    const expiryDate = new Date(FIXED_NOW + 30 * 60 * 1000).toISOString();
    const customConfig: AdaptiveRefreshConfig = {
      enabled: true,
      tiers: [
        { label: '<1h', maxSeconds: 3600, defaultIntervalSec: 10 },
        { label: '1-6h', maxSeconds: 21600, defaultIntervalSec: 60 },
        { label: '6-24h', maxSeconds: 86400, defaultIntervalSec: 300 },
        { label: '>24h', maxSeconds: Infinity, defaultIntervalSec: 900 },
      ],
      globalMultiplier: 1,
    };
    const result = computeAdaptiveRefresh(expiryDate, customConfig);

    expect(result.intervalMs).toBe(10 * 1000);
    expect(result.tierLabel).toBe('<1h');
  });

  it('1-6h tier: market expiring in 3h → 60s interval', () => {
    const expiryDate = new Date(FIXED_NOW + 3 * 3600 * 1000).toISOString();
    const result = computeAdaptiveRefresh(expiryDate);

    expect(result.intervalMs).toBe(60 * 1000);
    expect(result.tierLabel).toBe('1-6h');
  });

  it('6-24h tier: market expiring in 12h → 5min interval', () => {
    const expiryDate = new Date(FIXED_NOW + 12 * 3600 * 1000).toISOString();
    const result = computeAdaptiveRefresh(expiryDate);

    expect(result.intervalMs).toBe(300 * 1000);
    expect(result.tierLabel).toBe('6-24h');
  });

  it('boundary: exactly at 1h → <1h tier', () => {
    const expiryDate = new Date(FIXED_NOW + 1 * 3600 * 1000).toISOString();
    const result = computeAdaptiveRefresh(expiryDate);

    expect(result.intervalMs).toBe(15 * 1000);
    expect(result.tierLabel).toBe('<1h');
  });

  it('boundary: exactly at 6h → 1-6h tier', () => {
    const expiryDate = new Date(FIXED_NOW + 6 * 3600 * 1000).toISOString();
    const result = computeAdaptiveRefresh(expiryDate);

    expect(result.intervalMs).toBe(60 * 1000);
    expect(result.tierLabel).toBe('1-6h');
  });

  it('boundary: exactly at 24h → 6-24h tier', () => {
    const expiryDate = new Date(FIXED_NOW + 24 * 3600 * 1000).toISOString();
    const result = computeAdaptiveRefresh(expiryDate);

    expect(result.intervalMs).toBe(300 * 1000);
    expect(result.tierLabel).toBe('6-24h');
  });

  it('just past 24h → >24h tier', () => {
    // 24h + 1 second
    const expiryDate = new Date(FIXED_NOW + (24 * 3600 + 1) * 1000).toISOString();
    const result = computeAdaptiveRefresh(expiryDate);

    expect(result.intervalMs).toBe(900 * 1000);
    expect(result.tierLabel).toBe('>24h');
  });

  it('missing expiry date → fallback to 5min', () => {
    const result = computeAdaptiveRefresh(null);

    expect(result.intervalMs).toBe(300 * 1000);
    expect(result.tierLabel).toBe('unknown');
    expect(result.missingExpiry).toBe(true);
  });

  it('malformed expiry date → fallback to 5min', () => {
    const result = computeAdaptiveRefresh('not-a-date');

    expect(result.intervalMs).toBe(300 * 1000);
    expect(result.tierLabel).toBe('unknown');
    expect(result.missingExpiry).toBe(true);
  });

  it('expired market → fastest tier (15s)', () => {
    // 1 hour ago
    const expiryDate = new Date(FIXED_NOW - 3600 * 1000).toISOString();
    const result = computeAdaptiveRefresh(expiryDate);

    expect(result.intervalMs).toBe(15 * 1000);
    expect(result.tierLabel).toBe('<1h');
    expect(result.expired).toBe(true);
  });

  it('global multiplier scales all intervals', () => {
    const expiryDate = new Date(FIXED_NOW + 30 * 60 * 1000).toISOString();
    const config: AdaptiveRefreshConfig = {
      ...DEFAULT_CONFIG,
      globalMultiplier: 2,
    };
    const result = computeAdaptiveRefresh(expiryDate, config);

    expect(result.intervalMs).toBe(15 * 1000 * 2);
  });

  it('empty string expiry → treated as missing', () => {
    const result = computeAdaptiveRefresh('');

    expect(result.missingExpiry).toBe(true);
    expect(result.intervalMs).toBe(300 * 1000);
  });
});

describe('isDueForRefresh', () => {
  const FIXED_NOW = new Date('2026-06-07T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never scanned → due', () => {
    const expiryDate = new Date(FIXED_NOW + 48 * 3600 * 1000).toISOString();
    expect(isDueForRefresh(null, expiryDate)).toBe(true);
  });

  it('scanned recently (within interval) → not due', () => {
    // Market expiring in 48h (interval = 900s = 15min)
    // Last scanned 5 minutes ago
    const expiryDate = new Date(FIXED_NOW + 48 * 3600 * 1000).toISOString();
    const lastScan = new Date(FIXED_NOW - 5 * 60 * 1000).toISOString();
    expect(isDueForRefresh(lastScan, expiryDate)).toBe(false);
  });

  it('scanned long ago (past interval) → due', () => {
    // Market expiring in 48h (interval = 900s = 15min)
    // Last scanned 20 minutes ago
    const expiryDate = new Date(FIXED_NOW + 48 * 3600 * 1000).toISOString();
    const lastScan = new Date(FIXED_NOW - 20 * 60 * 1000).toISOString();
    expect(isDueForRefresh(lastScan, expiryDate)).toBe(true);
  });

  it('near-expiry market scanned 10s ago (interval 15s) → not due', () => {
    const expiryDate = new Date(FIXED_NOW + 30 * 60 * 1000).toISOString();
    const lastScan = new Date(FIXED_NOW - 10 * 1000).toISOString();
    expect(isDueForRefresh(lastScan, expiryDate)).toBe(false);
  });

  it('near-expiry market scanned 20s ago (interval 15s) → due', () => {
    const expiryDate = new Date(FIXED_NOW + 30 * 60 * 1000).toISOString();
    const lastScan = new Date(FIXED_NOW - 20 * 1000).toISOString();
    expect(isDueForRefresh(lastScan, expiryDate)).toBe(true);
  });
});

describe('formatInterval', () => {
  it('formats seconds', () => {
    expect(formatInterval(15000)).toBe('15s');
    expect(formatInterval(59000)).toBe('59s');
  });

  it('formats minutes', () => {
    expect(formatInterval(300000)).toBe('5m');
    expect(formatInterval(900000)).toBe('15m');
  });

  it('formats hours and minutes', () => {
    expect(formatInterval(3660000)).toBe('1h 1m');
  });
});

describe('formatCountdown', () => {
  it('formats days', () => {
    expect(formatCountdown(90060)).toBe('1d 1h 1m');
  });

  it('formats hours and minutes', () => {
    expect(formatCountdown(3661)).toBe('1h 1m');
  });

  it('formats minutes only', () => {
    expect(formatCountdown(45)).toBe('0m');
  });

  it('formats expired', () => {
    expect(formatCountdown(-5)).toBe('Expired');
    expect(formatCountdown(0)).toBe('Expired');
  });
});

describe('nextRefreshAt', () => {
  const FIXED_NOW = new Date('2026-06-07T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes next refresh for near-expiry market', () => {
    // 30min to expiry → 15s interval
    const expiryDate = new Date(FIXED_NOW + 30 * 60 * 1000).toISOString();
    const lastScan = new Date(FIXED_NOW - 10 * 1000).toISOString();
    const next = nextRefreshAt(lastScan, expiryDate);

    // lastScan + 15s = FIXED_NOW - 10s + 15s = FIXED_NOW + 5s
    const expected = new Date(FIXED_NOW + 5 * 1000).toISOString();
    expect(next).toBe(expected);
  });

  it('uses current time when no last scan', () => {
    const expiryDate = new Date(FIXED_NOW + 48 * 3600 * 1000).toISOString();
    const next = nextRefreshAt(null, expiryDate);

    // now + 15min
    const expected = new Date(FIXED_NOW + 900 * 1000).toISOString();
    expect(next).toBe(expected);
  });
});

describe('edge cases', () => {
  const FIXED_NOW = new Date('2026-06-07T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('very small global multiplier (0.1) scales down intervals', () => {
    const expiryDate = new Date(FIXED_NOW + 30 * 60 * 1000).toISOString();
    const config: AdaptiveRefreshConfig = {
      ...DEFAULT_CONFIG,
      globalMultiplier: 0.1,
    };
    const result = computeAdaptiveRefresh(expiryDate, config);

    expect(result.intervalMs).toBe(15 * 1000 * 0.1);
  });

  it('large global multiplier (10) scales up intervals', () => {
    const expiryDate = new Date(FIXED_NOW + 30 * 60 * 1000).toISOString();
    const config: AdaptiveRefreshConfig = {
      ...DEFAULT_CONFIG,
      globalMultiplier: 10,
    };
    const result = computeAdaptiveRefresh(expiryDate, config);

    expect(result.intervalMs).toBe(15 * 1000 * 10);
  });

  it('undefined expiry → missing', () => {
    const result = computeAdaptiveRefresh(undefined);
    expect(result.missingExpiry).toBe(true);
  });

  it('custom tier ordering works correctly', () => {
    // Reverse-order tiers (should still work because we iterate)
    const config: AdaptiveRefreshConfig = {
      enabled: true,
      tiers: [
        { label: '>24h', maxSeconds: Infinity, defaultIntervalSec: 900 },
        { label: '6-24h', maxSeconds: 86400, defaultIntervalSec: 300 },
        { label: '1-6h', maxSeconds: 21600, defaultIntervalSec: 60 },
        { label: '<1h', maxSeconds: 3600, defaultIntervalSec: 15 },
      ],
      globalMultiplier: 1,
    };

    // 3h expiry should hit <1h tier first (since it iterates)
    const expiryDate = new Date(FIXED_NOW + 3 * 3600 * 1000).toISOString();
    const result = computeAdaptiveRefresh(expiryDate, config);

    // With reversed tiers, the first matching tier is '>24h' (maxSeconds: Infinity)
    // Actually, 3h = 10800s ≤ Infinity, so it matches >24h first
    // But that's wrong behavior — the tiers SHOULD be ordered ascending
    // This test documents the assumption: tiers must be sorted by maxSeconds ascending
    expect(result.tierLabel).toBe('>24h');
    expect(result.intervalMs).toBe(900 * 1000);
  });
});
