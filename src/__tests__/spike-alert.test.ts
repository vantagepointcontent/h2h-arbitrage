import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpikeDetector, SpikeAlertPayload } from '../lib/spike-alert';

describe('SpikeDetector', () => {
  let detector: SpikeDetector;
  let callbacks: SpikeAlertPayload[] = [];

  beforeEach(() => {
    detector = new SpikeDetector({
      windowMs: 60_000,
      threshold: 10,
      cooldownMs: 300_000,
    });
    callbacks = [];
    detector.onAlert = (payload) => callbacks.push(payload);
    detector.reset();
  });

  it('should not alert when errors are below threshold', () => {
    for (let i = 0; i < 9; i++) {
      const alerted = detector.record({
        fingerprint: 'TypeError: market not found',
        message: `market ${i} not found`,
      });
      expect(alerted).toBe(false);
    }
    expect(callbacks.length).toBe(0);
  });

  it('should alert when errors reach threshold', () => {
    for (let i = 0; i < 9; i++) {
      detector.record({
        fingerprint: 'TypeError: market not found',
        message: `market ${i} not found`,
      });
    }
    const alerted = detector.record({
      fingerprint: 'TypeError: market not found',
      message: 'market 9 not found',
    });
    expect(alerted).toBe(true);
    expect(callbacks.length).toBe(1);
    expect(callbacks[0].count).toBe(10);
    expect(callbacks[0].threshold).toBe(10);
  });

  it('should fire alert with 15 errors in 1 minute', () => {
    for (let i = 0; i < 15; i++) {
      detector.record({
        fingerprint: 'ConnectionError: timeout',
        message: `request ${i} timed out`,
      });
    }
    expect(callbacks.length).toBe(1);
    expect(callbacks[0].count).toBeGreaterThanOrEqual(10);
  });

  it('should respect cooldown period', () => {
    // Fire first alert at threshold
    for (let i = 0; i < 10; i++) {
      detector.record({ fingerprint: 'E1', message: `err ${i}` });
    }
    expect(callbacks.length).toBe(1);

    // Add more errors — should NOT fire again within cooldown
    for (let i = 10; i < 20; i++) {
      detector.record({ fingerprint: 'E1', message: `err ${i}` });
    }
    expect(callbacks.length).toBe(1); // Still 1 — cooldown prevents second alert
  });

  it('should track error rate accurately', () => {
    for (let i = 0; i < 7; i++) {
      detector.record({ fingerprint: 'E1', message: `err ${i}` });
    }
    expect(detector.getCurrentRate()).toBe(7);
  });

  it('should group errors by fingerprint in breakdown', () => {
    detector.record({ fingerprint: 'TypeError: market not found', message: 'm1' });
    detector.record({ fingerprint: 'TypeError: market not found', message: 'm2' });
    detector.record({ fingerprint: 'ConnectionError: timeout', message: 't1' });

    const breakdown = detector.getBreakdown();
    expect(breakdown['TypeError: market not found']).toBe(2);
    expect(breakdown['ConnectionError: timeout']).toBe(1);
  });

  it('should reset clearing all events', () => {
    detector.record({ fingerprint: 'E1', message: 'err' });
    detector.reset();
    expect(detector.getCurrentRate()).toBe(0);
    expect(Object.keys(detector.getBreakdown()).length).toBe(0);
  });

  it('should include top errors in alert payload', () => {
    for (let i = 0; i < 5; i++) {
      detector.record({ fingerprint: 'TypeError: market not found', message: `m${i}` });
    }
    for (let i = 0; i < 5; i++) {
      detector.record({ fingerprint: 'ConnectionError: timeout', message: `t${i}` });
    }

    const payload = callbacks[0];
    expect(payload.topErrors.length).toBeGreaterThan(0);
    expect(payload.topErrors[0]).toContain('TypeError');
  });

  it('should not crash on callback errors', () => {
    detector.onAlert = () => { throw new Error('callback error'); };
    expect(() => {
      for (let i = 0; i < 10; i++) {
        detector.record({ fingerprint: 'E1', message: `err ${i}` });
      }
    }).not.toThrow();
  });
});
