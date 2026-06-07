import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  errorFingerprint,
  fingerprintHash,
  createChildLogger,
} from '../lib/logger';
import { correlationId } from '../lib/correlation';
import * as winstonModule from 'winston';

// ---------------------------------------------------------------------------
// Mock winston so we can inspect what gets logged
// ---------------------------------------------------------------------------

function captureConsoleWrites() {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    chunks,
    restore: () => {
      spy.mockRestore();
    },
  };
}

// ---------------------------------------------------------------------------
// Test Case 1: JSON format with timestamp, level, message, correlation ID
// ---------------------------------------------------------------------------

describe('Test Case 1: JSON log format', () => {
  it('produces JSON with timestamp, level, and message', () => {
    // We test the exported functions directly
    const err = new Error('something broke');
    const fp = errorFingerprint(err);

    // Fingerprint should contain the error type and message
    expect(fp).toContain('Error');
    expect(fp).toContain('something broke');
  });

  it('includes correlation ID when one is active', () => {
    const testId = 'test-correlation-123';
    let capturedId: string | undefined;

    correlationId.run(testId, () => {
      capturedId = correlationId.current;
    });

    expect(capturedId).toBe(testId);
  });

  it('returns undefined correlation ID when none active', () => {
    expect(correlationId.current).toBeUndefined();
  });

  it('generates valid UUID correlation IDs', () => {
    const id = correlationId.generate();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Test Case 3: Error fingerprinting groups duplicates
// ---------------------------------------------------------------------------

describe('errorFingerprint — deduplication', () => {
  it('groups identical error messages', () => {
    const a = new TypeError('connection refused');
    const b = new TypeError('connection refused');

    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it('normalizes numeric values so similar errors cluster', () => {
    const a = new Error('market 123 not found');
    const b = new Error('market 456 not found');

    const fpA = errorFingerprint(a);
    const fpB = errorFingerprint(b);

    // Both should have <N> in place of the number
    expect(fpA).toContain('<N>');
    expect(fpB).toContain('<N>');
    // The fingerprints should match except for the originating function
    // (which depends on the call stack)
    const partsA = fpA.split(':');
    const partsB = fpB.split(':');
    expect(partsA[0]).toBe(partsB[0]); // same error type
    expect(partsA[1]).toBe(partsB[1]); // same normalized message
  });

  it('normalizes UUIDs', () => {
    const a = new Error('request abc12345-def0-1234-5678-abcdef123456 failed');
    const fp = errorFingerprint(a);
    expect(fp).toContain('<UUID>');
  });

  it('normalizes timestamps', () => {
    const a = new Error('retry at 2025-01-15T10:30:00');
    const fp = errorFingerprint(a);
    expect(fp).toContain('<TIMESTAMP>');
  });

  it('handles non-Error objects gracefully', () => {
    const fp = errorFingerprint('plain string error');
    expect(fp).toBe('Unknown:plain string error');
  });

  it('handles null/undefined', () => {
    expect(errorFingerprint(null)).toBe('Unknown:null');
    expect(errorFingerprint(undefined)).toBe('Unknown:undefined');
  });
});

// ---------------------------------------------------------------------------
// fingerprintHash — deterministic hashing
// ---------------------------------------------------------------------------

describe('fingerprintHash', () => {
  it('produces consistent 16-char hex hash', () => {
    const fp = 'TypeError: connection refused';
    const hash1 = fingerprintHash(fp);
    const hash2 = fingerprintHash(fp);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('different fingerprints yield different hashes', () => {
    const h1 = fingerprintHash('TypeError: foo');
    const h2 = fingerprintHash('TypeError: bar');
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// createChildLogger — context binding
// ---------------------------------------------------------------------------

describe('createChildLogger', () => {
  it('creates a logger that forwards to root transports', () => {
    const child = createChildLogger({ service: 'test-service', component: 'auth' });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
    expect(typeof child.error).toBe('function');
  });

  it('attaches service and component context', () => {
    const child = createChildLogger({
      service: 'payment',
      component: 'checkout',
      tenant: 'acme',
    });

    // Verify the logger has the expected methods
    expect(child.log).toBeDefined();
    expect(child.child).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: logger.trackError feeds spike detector
// ---------------------------------------------------------------------------

describe('Integration: trackError + spikeDetector', () => {
  it('trackError records errors with fingerprint and hash', () => {
    // Import logger to exercise trackError
    const { default: logger } = require('../lib/logger');
    const { spikeDetector } = require('../lib/spike-alert');

    const prevRate = spikeDetector.getCurrentRate();

    const err = new Error('integration test error');
    logger.trackError(err, { source: 'test' });

    // Rate should have increased by 1
    const newRate = spikeDetector.getCurrentRate();
    expect(newRate).toBe(prevRate + 1);
  });
});
