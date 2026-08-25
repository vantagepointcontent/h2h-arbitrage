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

  it('detects a broad collapse of persisted market scan states to unavailable even when each row has a reason', () => {
    const healthyRows = Array.from({ length: 94 }, (_, index) => ({
      lastScanResult: {
        scannedAt: `2026-08-21T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
        matchStatus: 'confirmed_zero',
        matchError: null,
      },
      canonicalApyPct: null,
      canonicalApyUnavailableReason: 'no_canonical_arbitrage',
      canonicalCurrentRoiPct: null,
    }));
    const unavailableRows = Array.from({ length: 6 }, (_, index) => ({
      lastScanResult: {
        scannedAt: `2026-08-21T13:0${index}:00.000Z`,
        matchStatus: 'unavailable',
        matchError: 'clob_book_unavailable: exact token book request failed',
      },
      canonicalApyPct: null,
      canonicalApyUnavailableReason: 'no_canonical_arbitrage',
      canonicalCurrentRoiPct: null,
    }));

    expect(summarizeMarketsProjectionHealth([...healthyRows, ...unavailableRows])).toMatchObject({
      state: 'degraded',
      unavailableScanStates: 6,
      unavailableScanStatesPct: 6,
      unavailableScanStatesWithoutReason: 0,
      reasons: expect.arrayContaining([
        '6/100 persisted market scan state(s) are unavailable (6.00%), above the 5% degradation threshold',
      ]),
    });
  });

  it('detects field-level profit collapse and unexplained null ROI without counting confirmed no-arb as unavailable', () => {
    const noArbRows = Array.from({ length: 94 }, () => ({
      lastScanResult: { scannedAt: '2026-08-21T12:00:00.000Z', matchStatus: 'confirmed_zero' },
      canonicalApyPct: null,
      canonicalApyUnavailableReason: 'no_canonical_arbitrage',
      canonicalCurrentRoiPct: null,
      canonicalCurrentRoiStatus: 'not_applicable',
      canonicalCurrentRoiUnavailableReason: null,
      canonicalCurrentProfit: null,
      canonicalCurrentProfitStatus: 'not_applicable',
      canonicalCurrentProfitUnavailableReason: null,
    }));
    const collapsedProfitRows = Array.from({ length: 5 }, () => ({
      lastScanResult: { scannedAt: '2026-08-21T12:00:00.000Z', matchStatus: 'matched' },
      canonicalApyPct: 12,
      canonicalApyUnavailableReason: null,
      canonicalCurrentRoiPct: 2,
      canonicalCurrentRoiStatus: 'available',
      canonicalCurrentRoiUnavailableReason: null,
      canonicalCurrentProfit: null,
      canonicalCurrentProfitStatus: 'unavailable',
      canonicalCurrentProfitUnavailableReason: 'non_positive_canonical_candidate_profit',
    }));
    const unexplainedRoi = {
      ...collapsedProfitRows[0],
      canonicalCurrentRoiPct: null,
      canonicalCurrentRoiStatus: 'unavailable',
      canonicalCurrentRoiUnavailableReason: null,
    };

    expect(summarizeMarketsProjectionHealth([...noArbRows, ...collapsedProfitRows, unexplainedRoi])).toMatchObject({
      state: 'degraded',
      notApplicableRoi: 94,
      unavailableRoi: 1,
      unavailableRoiWithoutReason: 1,
      notApplicableProfit: 94,
      unavailableProfit: 6,
      unavailableProfitWithoutReason: 0,
      unavailableProfitPct: 6,
      reasons: expect.arrayContaining([
        '1 unavailable current ROI field(s) lack a specific reason',
        '6/100 scanned current profit field(s) are unavailable (6.00%), above the 5% degradation threshold',
      ]),
    });
  });

  it('keeps a small explicitly reasoned field-unavailable cohort below the broad-collapse threshold', () => {
    const rows = [
      ...Array.from({ length: 472 }, (_, index) => ({
        id: `no-arb-${index}`,
        lastScanResult: { matchStatus: 'confirmed_zero', scannedAt: '2026-08-25T22:00:00.000Z' },
        canonicalCurrentRoiPct: null,
        canonicalCurrentRoiStatus: 'not_applicable',
        canonicalCurrentProfit: null,
        canonicalCurrentProfitStatus: 'not_applicable',
        canonicalApyPct: null,
        canonicalApyUnavailableReason: 'no_canonical_arbitrage',
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        id: `retained-${index}`,
        lastScanResult: { matchStatus: 'unavailable', matchError: 'clob_book_unavailable', scannedAt: '2026-08-25T22:00:00.000Z' },
        canonicalCurrentRoiPct: 0.2,
        canonicalCurrentRoiStatus: 'available',
        canonicalCurrentProfit: null,
        canonicalCurrentProfitStatus: 'unavailable',
        canonicalCurrentProfitUnavailableReason: 'canonical_profit_not_persisted_for_retained_revision',
        canonicalApyPct: 0.5,
      })),
    ];

    const health = summarizeMarketsProjectionHealth(rows);
    expect(health.reasons).toEqual([]);
    expect(health).toMatchObject({
      state: 'healthy',
      total: 474,
      unavailableProfit: 2,
      unavailableProfitWithoutReason: 0,
    });
  });
});
