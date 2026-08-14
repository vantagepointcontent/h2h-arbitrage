import { describe, expect, it } from 'vitest';
import {
  classifyPollerHealth,
  EXPECTED_POLLER_SCHEDULER_VERSION,
  POLLER_STALE_AFTER_MS,
} from './poller-health';

describe('poller health deployment fencing', () => {
  const now = Date.parse('2026-08-14T10:00:00Z');

  it('flags a missing or old-version poller instead of reporting a healthy app alone', () => {
    expect(classifyPollerHealth(null, now)).toMatchObject({
      available: false,
      mixedVersion: true,
      stale: true,
    });
    expect(classifyPollerHealth({
      schedulerVersion: 'legacy-array-order',
      startedAt: new Date(now - 1_000).toISOString(),
    }, now)).toMatchObject({
      available: true,
      mixedVersion: true,
      stale: false,
    });
  });

  it('detects stalled logs/cycles from the durable heartbeat age', () => {
    expect(classifyPollerHealth({
      schedulerVersion: EXPECTED_POLLER_SCHEDULER_VERSION,
      finishedAt: new Date(now - POLLER_STALE_AFTER_MS - 1).toISOString(),
    }, now)).toMatchObject({ mixedVersion: false, stale: true });
  });

  it('keeps a long-running cycle healthy while progress heartbeats advance', () => {
    expect(classifyPollerHealth({
      schedulerVersion: EXPECTED_POLLER_SCHEDULER_VERSION,
      startedAt: new Date(now - 10 * 60_000).toISOString(),
      heartbeatAt: new Date(now - 5_000).toISOString(),
    }, now)).toMatchObject({ mixedVersion: false, stale: false });
  });
});
