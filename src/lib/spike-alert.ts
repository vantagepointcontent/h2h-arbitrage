/**
 * Spike alert detector — pure module with no dependency on logger.
 *
 * This avoids a circular dependency: logger.ts imports spikeDetector,
 * and spike-alert.ts previously imported logger for its internal warn().
 * That worked at runtime thanks to ES module deferred bindings, but it was
 * fragile. Now spike-alert is a standalone concern that emits events via
 * the `onAlert` callback; the consumer (logger.ts) attaches the logging.
 */

interface ErrorEvent {
  timestamp: number;
  fingerprint: string;
  message: string;
}

export interface SpikeAlertOptions {
  /** Time window in milliseconds (default: 60 000 = 1 min) */
  windowMs?: number;
  /** Error count that triggers an alert (default: 10) */
  threshold?: number;
  /** Cooldown between alerts in ms (default: 300 000 = 5 min) */
  cooldownMs?: number;
}

export interface SpikeAlertPayload {
  count: number;
  threshold: number;
  breakdown: Record<string, number>;
  topErrors: string[];
}

export class SpikeDetector {
  private events: ErrorEvent[] = [];
  private readonly windowMs: number;
  private readonly threshold: number;
  private lastAlertTime = 0;
  private readonly cooldownMs: number;

  /**
   * Callback invoked when a spike alert fires.
   * Registered by the consumer (logger.ts wires it up after init).
   */
  onAlert: ((payload: SpikeAlertPayload) => void) | null = null;

  constructor(options?: SpikeAlertOptions) {
    this.windowMs = options?.windowMs ?? 60_000; // 1 minute
    this.threshold = options?.threshold ?? 10;
    this.cooldownMs = options?.cooldownMs ?? 300_000; // 5 min between alerts
  }

  /**
   * Record an error event and check if we've crossed the spike threshold.
   * Returns true if an alert was triggered.
   */
  record(event: { fingerprint: string; message: string }): boolean {
    const now = Date.now();
    this.events.push({ timestamp: now, fingerprint: event.fingerprint, message: event.message });

    this.prune(now);

    const countInWindow = this.countInWindow(now);

    if (countInWindow >= this.threshold && now - this.lastAlertTime > this.cooldownMs) {
      const payload = this.buildAlertPayload(countInWindow);
      this.lastAlertTime = now;

      if (this.onAlert) {
        try {
          this.onAlert(payload);
        } catch {
          // Swallow callback errors — don't break spike detection
        }
      }

      return true;
    }

    return false;
  }

  /** Current error count in the sliding window. */
  getCurrentRate(): number {
    const now = Date.now();
    this.prune(now);
    return this.events.length;
  }

  /** Breakdown of recent errors by fingerprint. */
  getBreakdown(): Record<string, number> {
    const now = Date.now();
    this.prune(now);
    const breakdown: Record<string, number> = {};
    for (const evt of this.events) {
      breakdown[evt.fingerprint] = (breakdown[evt.fingerprint] ?? 0) + 1;
    }
    return breakdown;
  }

  /** Reset all tracked events — useful for testing. */
  reset(): void {
    this.events = [];
    this.lastAlertTime = 0;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    this.events = this.events.filter(e => e.timestamp >= cutoff);
  }

  private countInWindow(now: number): number {
    const cutoff = now - this.windowMs;
    return this.events.filter(e => e.timestamp >= cutoff).length;
  }

  private buildAlertPayload(count: number): SpikeAlertPayload {
    const breakdown = this.getBreakdown();
    const topErrors = Object.entries(breakdown)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([fp, cnt]) => `  ${fp}: ${cnt}x`);

    return { count, threshold: this.threshold, breakdown, topErrors };
  }
}

export const spikeDetector = new SpikeDetector();
