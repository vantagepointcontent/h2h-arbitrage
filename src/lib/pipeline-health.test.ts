import { describe, expect, it } from 'vitest';
import { classifyBotConsumerHealth, summarizeMarketsProjectionHealth } from './pipeline-health';

describe('producer-to-consumer pipeline health', () => {
  it('does not let an online process mask a stale BotTrader consumer or cursor gap', () => {
    const health = classifyBotConsumerHealth({
      heartbeat: { state: 'healthy', lastSuccessAt: '2026-08-21T12:00:00.000Z' },
      scanHealth: { pendingScans: 2, cursorLag: 2, cursorScanId: 40, latestCompletedScanId: 42 },
      now: Date.parse('2026-08-21T12:00:10.000Z'),
    });

    expect(health).toMatchObject({ state: 'degraded', pendingScans: 2, cursorLag: 2 });
    expect(health.reasons).toContain('2 persisted scan(s) await a terminal BotTrader decision');
  });

  it('classifies a current zero-gap BotTrader cursor independently as healthy', () => {
    expect(classifyBotConsumerHealth({
      heartbeat: { state: 'healthy', lastSuccessAt: '2026-08-21T12:00:00.000Z' },
      scanHealth: { pendingScans: 0, cursorLag: 0, cursorScanId: 42, latestCompletedScanId: 42 },
      now: Date.parse('2026-08-21T12:00:10.000Z'),
    })).toMatchObject({ state: 'healthy', reasons: [] });
  });

  it('does not treat non-transactional ID skew as a gap when the authoritative pending count is zero', () => {
    expect(classifyBotConsumerHealth({
      heartbeat: { state: 'healthy', lastSuccessAt: '2026-08-21T12:00:00.000Z' },
      scanHealth: { pendingScans: 0, cursorLag: 0, cursorScanId: 42, latestCompletedScanId: 45 },
      now: Date.parse('2026-08-21T12:00:10.000Z'),
    })).toMatchObject({ state: 'healthy', reasons: [] });
  });

  it('fails closed when the consumer heartbeat omits cursor evidence', () => {
    expect(classifyBotConsumerHealth({
      heartbeat: { state: 'healthy', lastSuccessAt: '2026-08-21T12:00:00.000Z' },
      scanHealth: {},
      now: Date.parse('2026-08-21T12:00:10.000Z'),
    })).toMatchObject({
      state: 'degraded',
      reasons: expect.arrayContaining(['BotTrader cursor health evidence is missing or malformed']),
    });
  });

  it('does not coerce null or empty cursor fields into healthy zero values', () => {
    expect(classifyBotConsumerHealth({
      heartbeat: { state: 'healthy', lastSuccessAt: '2026-08-21T12:00:00.000Z' },
      scanHealth: { pendingScans: null, cursorLag: '', cursorScanId: null, latestCompletedScanId: '' },
      now: Date.parse('2026-08-21T12:00:10.000Z'),
    }).state).toBe('degraded');
  });

  it('requires every unavailable Markets field to carry a specific reason without becoming zero', () => {
    const summary = summarizeMarketsProjectionHealth([
      { lastScanResult: { scannedAt: '2026-08-21T12:00:00.000Z' }, canonicalApyPct: null, canonicalApyUnavailableReason: 'no_canonical_arbitrage', canonicalCurrentRoiPct: null },
      { lastScanResult: { scannedAt: '2026-08-21T12:00:01.000Z' }, canonicalApyPct: null, canonicalApyUnavailableReason: null, canonicalCurrentRoiPct: 0 },
      { lastScanResult: { scannedAt: '2026-08-21T12:00:02.000Z' }, canonicalApyPct: 12, canonicalApyUnavailableReason: null, canonicalCurrentRoiPct: 2 },
    ]);

    expect(summary).toMatchObject({
      state: 'degraded', total: 3, scanned: 3, availableApy: 1,
      unavailableWithReason: 1, unavailableWithoutReason: 1, zeroCurrentRoi: 1,
    });
  });
});
