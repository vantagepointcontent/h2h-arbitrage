// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BotTraderPanel, { positionRoiBps } from './BotTraderPanel';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Legend: () => null,
  Bar: () => null,
}));

const analytics = {
  totalBotTrades: { paper: 47, production: 3, total: 50 },
  openPositions: { count: 12, unrealizedPnlCents: 1234 },
  settledPositions: { count: 19, realizedPnlCents: 567, winRateBps: 6842 },
  averageRoi: { atTradeBps: 240, currentBps: 190 },
  bestTrade: null,
  worstTrade: null,
  dailyPnl: [],
  timeStats: { tradesPerDayBps: 10000, averageHoldSeconds: 0 },
  performance: {
    positionIds: [1],
    capital: { deployedCents: 97, currentCents: 102, heldToResolutionCents: 100 },
    entryCost: { available: 1, unavailable: 0 },
    pnl: { realizedCents: 0, unrealizedCents: 5, totalCents: 5, roiBps: 515 },
    valuation: { fresh: 1, stale: 0, unavailable: 0, pendingSettlement: 0, asOf: '2026-08-11T13:40:00.000Z' },
    entryCohorts: [{ date: '2026-08-08', deployedCents: 97, currentCents: 102, heldToResolutionCents: 100, realizedCents: 0, unrealizedCents: 5, trades: 1 }],
  },
};

const positions = [{
  id: 1,
  executionId: 9,
  marketId: 'market-1',
  marketTitle: 'Trump 2026',
  kalshiTicker: 'KXTRUMP-26',
  pmConditionId: '0xabc',
  kalshiUrl: 'https://kalshi.com/markets/kxtrump-26',
  polymarketUrl: 'https://polymarket.com/event/trump-2026',
  strategy: 'Buy YES K + NO PM',
  kalshiOutcomeLabel: 'Republicans',
  pmOutcomeLabel: 'Republicans',
  outcomeIdentityStatus: 'verified',
  outcomeIdentitySource: 'canonical_proposition_relationship_v1',
  pmEntryTokenId: 'held-republican-token',
  kalshiSide: 'yes',
  pmSide: 'no',
  buyPriceKalshiCents: 45,
  buyPricePmCents: 52,
  sharesKalshi: 1,
  sharesPm: 1,
  totalCostCents: 97,
  entryCostStatus: 'available',
  entryCostFailureReason: null,
  kalshiEntryGrossMicrocents: 45_000_000,
  pmEntryGrossMicrocents: 52_000_000,
  kalshiEntryFeeCents: 0,
  pmEntryFeeCents: 0,
  entryCostRoundingDeltaMicrocents: 0,
  kalshiEntryFillCount: 1,
  pmEntryFillCount: 1,
  entryArbProfitSnapshot: {
    version: 1,
    status: 'available' as const,
    profitMicrousd: 30_000,
    currency: 'USDC' as const,
    monetaryUnit: 'microusd' as const,
    matchedQuantityMicrounits: 1_000_000,
    guaranteedPayoutMicrousd: 1_000_000,
    grossFillsMicrocents: { kalshi: 45_000_000, polymarket: 52_000_000 },
    entryFeesMicrousd: { kalshi: 0, polymarket: 0 },
    settlementFeeAssumptionMicrousd: 0,
    formula: 'guaranteed_payout_microusd-total_cost_microusd-settlement_fee_assumption_microusd' as const,
    formulaVersion: 1 as const,
    provenance: 'simulated_placement_fills' as const,
    executionMode: 'paper' as const,
    capturedAt: '2026-08-08T16:00:00.000Z',
    relationshipState: 'verified_complementary' as const,
    entryRoi: { numeratorMicrousd: 30_000, denominatorMicrousd: 970_000 },
    legs: {
      kalshi: { marketId: 'KXTRUMP-26', tokenId: null, side: 'yes' as const, outcome: 'Republicans' },
      polymarket: { marketId: '0xabc', tokenId: 'held-republican-token', side: 'no' as const, outcome: 'Republicans' },
    },
  },
  expectedPayoutCents: 100,
  expectedProfitCents: 3,
  feesCents: 0,
  status: 'open',
  openedAt: '2026-08-08T16:00:00.000Z',
  expiryDate: '2026-12-31T00:00:00.000Z',
  settledAt: null,
  currentPriceKalshiCents: 48,
  currentPricePmCents: 54,
  currentPriceSnapshots: {
    kalshi: { status: 'available', priceCents: 47, source: 'saved-market-full-scan', observedAt: '2026-08-11T13:39:00.000Z', ageMs: 60_000 },
    polymarket: { status: 'stale', priceCents: 55, source: 'saved-market-quick-refresh', observedAt: '2026-08-11T12:00:00.000Z', ageMs: 6_000_000 },
  },
  currentValueCents: 102,
  kalshiGrossProceedsMicrocents: 48_000_000,
  pmGrossProceedsMicrocents: 54_000_000,
  kalshiNetProceedsCents: 48,
  pmNetProceedsCents: 54,
  kalshiExitFeeCents: 0,
  pmExitFeeCents: 0,
  kalshiExitFeeType: 'quadratic',
  kalshiExitFeeMultiplierPpm: 1_000_000,
  kalshiExitFeeSource: 'kalshi-series:KXTEST',
  kalshiExitFeeObservedAt: '2026-08-11T13:39:00.000Z',
  kalshiExitFeeVersion: 'quadratic:1000000:v1',
  pmExitFeeRateBps: 400,
  pmExitFeeSource: 'polymarket-clob:/fee-rate?token_id=held',
  pmExitFeeObservedAt: '2026-08-11T13:39:00.000Z',
  pmExitFeeVersion: 'token-fee-rate:400',
  // Deliberately inconsistent legacy fields: the table must derive these from
  // currentValueCents and totalCostCents instead of trusting stale mappings.
  unrealizedPnlCents: 97,
  unrealizedRoiBps: 9999,
  lastValuationAt: '2026-08-11T13:40:00.000Z',
  realizedPnlCents: null,
  settlementSide: null,
  dryRun: true,
}];

function response(data: unknown, ok = true) {
  return Promise.resolve({ ok, json: async () => data });
}

function stubInitialFetch() {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/analytics')) return response({ success: true, analytics: url.includes('mode=production') ? {
      ...analytics,
      positions: [],
      totalBotTrades: { paper: 0, production: 0, total: 0 },
      openPositions: { count: 0, unrealizedPnlCents: 0 },
      settledPositions: { count: 0, realizedPnlCents: 0, winRateBps: 0 },
      performance: {
        positionIds: [],
        capital: { deployedCents: 0, currentCents: 0, heldToResolutionCents: 0 },
        pnl: { realizedCents: 0, unrealizedCents: 0, totalCents: 0, roiBps: null },
        valuation: { fresh: 0, stale: 0, unavailable: 0, pendingSettlement: 0, asOf: null },
        entryCohorts: [],
      },
    } : { ...analytics, positions } });
    if (url.includes('/positions')) return response({ success: true, positions });
    if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
    throw new Error(`Unexpected fetch: ${url}`);
  }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BotTraderPanel', () => {
  it('shows a dedicated loading state while the verified performance snapshot is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<BotTraderPanel />);
    expect(screen.getByText('Loading BotTrader analytics…')).toBeTruthy();
  });

  it('shows a retryable full error state when the performance query fails', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: false, error: 'Analytics unavailable' }, false);
      if (url.includes('/positions')) return response({ success: true, positions: [] });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);
    expect((await screen.findByRole('alert')).textContent).toContain('Analytics unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('queries BotTrader-only analytics with explicit mode, method, and Dashboard range semantics', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);
    await screen.findByText('Trump 2026');

    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/bot-trader/analytics?method=all&mode=paper&range=30d')).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Performance method' }), { target: { value: 'roi' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '7 Days' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '7 Days' }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/bot-trader/analytics?method=roi&mode=paper&range=7d')).toBe(true));
  });

  it('keeps an already-active filter idempotent instead of entering a stuck loading state', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);
    await screen.findByText('Trump 2026');
    const callsBefore = vi.mocked(fetch).mock.calls.length;

    fireEvent.change(screen.getByRole('combobox', { name: 'Performance method' }), { target: { value: 'all' } });

    expect(screen.queryByText('Loading BotTrader analytics…')).toBeNull();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(callsBefore);
  });

  it('renders fee-inclusive performance cards and executable quote freshness from one analytics response', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);

    await screen.findByText('Trump 2026');
    expect(screen.getByText('Deployed').parentElement?.textContent).toBe('Deployed$0.97');
    expect(screen.getByText('Indicative value').parentElement?.textContent).toBe('Indicative value$1.02');
    expect(screen.getByText('Held to resolution').parentElement?.textContent).toBe('Held to resolution$1.00');
    expect(screen.getByText('Portfolio ROI').parentElement?.textContent).toBe('Portfolio ROI+5.2%');
    expect(screen.getByText(/Indicative marks fresh for 1 open position/)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'BotTrader current performance by entry date chart' })).toBeTruthy();
  });

  it('reconciles a partially reduced row with the portfolio current ROI', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    const reduced = {
      ...positions[0],
      sharesKalshi: 3,
      remainingSharesKalshi: 1,
      remainingSharesPm: 1,
      remainingOpenCostCents: 89,
      totalCostCents: 98,
      currentValueCents: 100,
      kalshiGrossProceedsMicrocents: 10_000_000,
      pmGrossProceedsMicrocents: 90_000_000,
      kalshiNetProceedsCents: 10,
      pmNetProceedsCents: 90,
      kalshiExitFeeCents: 0,
      pmExitFeeCents: 0,
      realizedPnlCents: 4,
      lastValuationAt: '2026-08-11T13:40:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: {
        ...analytics,
        positions: [reduced],
        performance: {
          ...analytics.performance,
          capital: { deployedCents: 89, currentCents: 100, heldToResolutionCents: 100, excludedOpenCostCents: 0 },
          pnl: { realizedCents: 4, unrealizedCents: 11, totalCents: 15, roiBps: 1685 },
        },
      } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    await screen.findByText('Trump 2026');
    expect(screen.getByText('Deployed').parentElement?.textContent).toBe('Deployed$0.89');
    expect(screen.getByText('Portfolio ROI').parentElement?.textContent).toBe('Portfolio ROI+16.9%');
    expect(screen.getByText('Trump 2026').closest('tr')?.textContent).toContain('$1.00+$0.15+16.9%');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Trump 2026' }));
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('1 held · 10.000¢ VWAP');
    expect(screen.getByTestId('polymarket-liquidation').textContent).toContain('1 held · 90.000¢ VWAP');
  });

  it('renders partial valuation and range-specific empty states without misleading P&L', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: {
        ...analytics,
        positions: [],
        totalBotTrades: { paper: 1, production: 0, total: 1 },
        performance: {
          positionIds: [],
          capital: { deployedCents: 97, currentCents: 0, heldToResolutionCents: 100, excludedOpenCostCents: 97 },
          pnl: { realizedCents: 0, unrealizedCents: 0, totalCents: 0, roiBps: null },
          valuation: { fresh: 0, stale: 1, unavailable: 0, pendingSettlement: 0, asOf: null },
          entryCohorts: [],
        },
      } });
      if (url.includes('/positions')) return response({ success: true, positions: [] });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    expect(await screen.findByText(/1 stale indicative mark/)).toBeTruthy();
    expect(screen.getByText('Indicative value').parentElement?.textContent).toBe('Indicative value$0.00');
    expect(screen.getByText('Unrealized').parentElement?.textContent).toBe('Unrealized$0.00');
    expect(screen.getByText(/\$0\.97 of unavailable open buy cost is excluded/)).toBeTruthy();
    expect(screen.getByText('No verified BotTrader executions in this range.')).toBeTruthy();
  });

  it('renders terminal value from the identity-validated resolution payout', async () => {
    const terminal = {
      ...positions[0],
      status: 'closed',
      totalCostCents: 97,
      currentValueCents: 88,
      realizedPnlCents: 3,
      resolutionPayoutCents: 100,
      resolutionValidationStatus: 'verified',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [terminal] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    await screen.findByText('Trump 2026');
    const row = screen.getByText('Trump 2026').closest('tr');
    expect(row?.textContent).toContain('$1.00+$0.03+3.1%');
    expect(row?.textContent).not.toContain('$0.88');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Trump 2026' }));
    expect(screen.getByText('Liquidation breakdown: Not applicable after resolution')).toBeTruthy();
    expect(screen.queryByTestId('combined-net-proceeds')).toBeNull();
  });

  it('shows fail-closed legacy settlement outside Open without a fabricated zero loss', async () => {
    const unresolved = {
      ...positions[0],
      settlementState: 'settlement_unresolved',
      settlementFailureReason: 'Settlement unresolved — exact legacy leg evidence missing',
      currentValueCents: null,
      unrealizedPnlCents: null,
      unrealizedRoiBps: null,
      realizedPnlCents: null,
      valuationFailureReason: 'Settlement unresolved — exact legacy leg evidence missing',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [unresolved] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    const row = (await screen.findByText('Trump 2026')).closest('tr');
    expect(row?.textContent).toContain('Settlement unresolved — exact legacy leg evidence missing');
    expect(row?.textContent).toContain('Settlement unresolved');
    expect(row?.textContent).not.toContain('-100.0%');
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.queryByText('Trump 2026')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settled' }));
    expect(await screen.findByText('Trump 2026')).toBeTruthy();
  });

  it('labels verified simulated terminal proceeds as Settled paper', async () => {
    const settledPaper = {
      ...positions[0], status: 'settled', settlementState: 'settled',
      settlementGrossProceedsCents: 100, settlementNetProceedsCents: 100,
      resolutionPayoutCents: 100, resolutionValidationStatus: 'verified',
      realizedPnlCents: 3, realizedRoiBps: 309, currentValueCents: null,
      settlementCashAvailableAt: '2026-08-19T12:00:02.000Z',
      settlementLegs: [{
        venue: 'kalshi', lifecycleState: 'reconciled', marketId: 'KXTRUMP-26', outcomeId: 'KXTRUMP-26:YES',
        side: 'yes', filledQuantity: 1, resolutionWinningSide: 'yes', resolutionDetectedAt: '2026-08-19T12:00:00.000Z',
        resolutionSource: 'kalshi_market_settlement', payoutEntitlementCents: 100, settlementFeeCents: 0,
        netSettlementProceedsCents: 100, creditState: 'simulated_credited', cashAvailableAt: '2026-08-19T12:00:02.000Z', failureReason: null,
      }, {
        venue: 'polymarket', lifecycleState: 'reconciled', marketId: '0xabc', outcomeId: 'held-republican-token',
        side: 'no', filledQuantity: 1, resolutionWinningSide: 'yes', resolutionDetectedAt: '2026-08-19T12:00:01.000Z',
        resolutionSource: 'polymarket_clob_market', payoutEntitlementCents: 0, settlementFeeCents: 0,
        netSettlementProceedsCents: 0, creditState: 'not_applicable', cashAvailableAt: null, failureReason: null,
      }],
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [settledPaper] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    const row = (await screen.findByText('Trump 2026')).closest('tr');
    expect(row?.textContent).toContain('Settled (paper)');
    expect(row?.textContent).toContain('$1.00');
    expect(row?.textContent).toContain('+$0.03');
    const settledCells = Array.from(row!.querySelectorAll('td'));
    expect(settledCells[7].textContent).toBe('+$0.03');
    expect(settledCells[9].textContent).toBe('$0.03');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Trump 2026' }));
    expect(screen.getByText('Settlement ledger').parentElement?.textContent).toContain('Simulated paper settlement');
    expect(screen.getByTestId('kalshi-settlement-leg').textContent).toContain('simulated credited');
    expect(screen.getByTestId('polymarket-settlement-leg').textContent).toContain('not applicable');
    expect(screen.getByText('Net settlement proceeds').parentElement?.textContent).toContain('$1.00');
  });

  it('derives settled ROI from realized P&L and total cost', () => {
    expect(positionRoiBps({ status: 'settled', totalCostCents: 200, realizedPnlCents: 25, unrealizedRoiBps: 9999 })).toBe(1250);
    expect(positionRoiBps({ status: 'open', totalCostCents: 200, realizedPnlCents: null, unrealizedRoiBps: 515 })).toBe(515);
  });

  it('renders status, analytics cents, and live positions from the bot APIs', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    stubInitialFetch();
    render(<BotTraderPanel />);

    await waitFor(() => expect(screen.getByText('Trump 2026')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Open Trump 2026 market' }).getAttribute('href')).toBe('/?view=scan&id=market-1');
    expect(screen.getByRole('link', { name: 'Open exact Kalshi YES market for Trump 2026' }).getAttribute('href')).toBe('https://kalshi.com/markets/kxtrump-26');
    expect(screen.getByRole('link', { name: 'Open exact Polymarket NO market for Trump 2026' }).getAttribute('href')).toBe('https://polymarket.com/event/trump-2026');
    const row = screen.getByRole('link', { name: 'Open Trump 2026 market' }).closest('tr')!;
    const cells = Array.from(row.querySelectorAll('td'));
    expect(cells[2].textContent).toBe('K: RepublicansPM: Republicans');
    expect(cells[4].textContent).toBe('Kalshi YESPM NO');
    expect(screen.getByRole('link', { name: 'Export exact legs CSV' }).getAttribute('href')).toBe('/api/bot-trader/positions/export?method=all&mode=paper&range=30d');
    expect(screen.getByText('Verified trades').parentElement?.textContent).toBe('Verified trades50');
    expect(screen.getByText('Open positions').parentElement?.textContent).toBe('Open positions12');
    expect(screen.getByText('Win rate').parentElement?.textContent).toBe('Win rate68.4%');
    expect(screen.getAllByText('+$0.05')).toHaveLength(3);
    expect(screen.getByText(/BotTrader: OFF/)).toBeTruthy();
    expect(screen.getByText('BotTrader Analytics')).toBeTruthy();
    const activeRange = screen.getByRole('button', { name: '30 Days' }) as HTMLButtonElement;
    expect(activeRange.disabled).toBe(true);
    expect(screen.getByText(/\$10\.50 staked/)).toBeTruthy();
  });

  it('places canonical per-leg outcomes between Market and Method without mixing them with contract sides', async () => {
    const oppositeOutcomes = {
      ...positions[0],
      id: 2,
      executionId: 10,
      marketTitle: 'NY-21 House Election Winner',
      kalshiOutcomeLabel: 'Republican',
      pmOutcomeLabel: 'Democratic',
      kalshiSide: 'yes',
      pmSide: 'yes',
    };
    const missingIdentity = {
      ...positions[0],
      id: 3,
      executionId: 11,
      marketTitle: 'Legacy market',
      kalshiOutcomeLabel: 'Fabricated candidate',
      pmOutcomeLabel: 'Fabricated opponent',
      outcomeIdentityStatus: 'unresolved' as const,
      outcomeIdentityFailureReason: 'Execution-time selected outcome was not persisted',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: {
        ...analytics,
        positions: [oppositeOutcomes, missingIdentity],
        performance: { ...analytics.performance, positionIds: [2, 3] },
      } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    const market = await screen.findByRole('link', { name: 'Open NY-21 House Election Winner market' });
    const table = market.closest('table')!;
    expect(Array.from(table.querySelectorAll('th')).map((header) => header.textContent?.trim())).toEqual([
      '', 'Market', 'Outcome', 'Method', 'Strategy', 'Buy Cost', 'Current Value', 'P&L', 'ROI', 'Entry Arb Profit', 'Status', 'Opened',
    ]);
    const row = market.closest('tr')!;
    const cells = Array.from(row.querySelectorAll('td'));
    expect(cells).toHaveLength(12);
    expect(cells[2].textContent).toBe('K: RepublicanPM: Democratic');
    expect(cells[2].textContent).not.toMatch(/YES|NO/);
    expect(cells[3].textContent).toBe('Legacy/Unknown');
    expect(cells[4].textContent).toBe('Kalshi YESPM YES');
    expect(cells[2].getAttribute('aria-label')).toBe('Placed outcomes: Kalshi Republican; Polymarket Democratic');
    expect(cells[2].className).toContain('lg:table-cell');
    expect(row.querySelector('[data-testid="responsive-position-outcome"]')?.textContent).toBe('K: Republican · PM: Democratic');

    const legacyRow = screen.getByText('Legacy market').closest('tr')!;
    expect(Array.from(legacyRow.querySelectorAll('td'))[2].textContent).toBe('Outcome unavailable');
    expect(Array.from(legacyRow.querySelectorAll('td'))[2].getAttribute('title')).toBe('Execution-time selected outcome was not persisted');
    expect(legacyRow.textContent).not.toContain('Fabricated candidate');
    expect(legacyRow.textContent).not.toContain('Fabricated opponent');
  });

  it('renders the canonical immutable Entry Arb Profit between dynamic ROI and Status', async () => {
    const changedCurrentValuation = {
      ...positions[0],
      currentValueCents: 75,
      unrealizedPnlCents: -22,
      unrealizedRoiBps: -2268,
      entryArbProfitSnapshot: {
        ...positions[0].entryArbProfitSnapshot,
        profitMicrousd: 790_000,
        entryRoi: { numeratorMicrousd: 790_000, denominatorMicrousd: 210_000 },
      },
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [changedCurrentValuation] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    const market = await screen.findByRole('link', { name: 'Open Trump 2026 market' });
    const headers = Array.from(market.closest('table')!.querySelectorAll('th'));
    expect(headers[9].textContent).toBe('Entry Arb Profit');
    expect(headers[9].getAttribute('title')).toBe('Net profit expected from the verified placed arb if held to settlement, captured at entry');
    const entryHeader = screen.getByRole('columnheader', { name: 'Entry Arb Profit' });
    expect(entryHeader).toHaveAccessibleDescription('Net profit expected from the verified placed arb if held to settlement, captured at entry');
    entryHeader.focus();
    expect(entryHeader).toHaveFocus();
    expect(entryHeader.className).toContain('focus-visible:ring');

    const cells = Array.from(market.closest('tr')!.querySelectorAll('td'));
    expect(cells[8].textContent).toBe('-22.7%');
    expect(cells[9].textContent).toBe('$0.79');
    expect(cells[9].className).toContain('status-positive');
    expect(cells[9]).toHaveAccessibleName('Entry Arb Profit $0.79 USDC');
    expect(cells[9]).toHaveAccessibleDescription(/Simulated paper placement snapshot; Simulated placement fills; captured 2026-08-08T16:00:00.000Z/);
    expect(cells[9].getAttribute('title')).toContain('Simulated paper placement snapshot');
    cells[9].focus();
    expect(cells[9]).toHaveFocus();
    expect(cells[9].className).toContain('focus-visible:ring');
    expect(cells[10].textContent).toBe('open');
    const responsiveEntryProfit = screen.getByTestId('responsive-entry-arb-profit');
    expect(responsiveEntryProfit.textContent).toBe('Entry arb $0.79');
    expect(responsiveEntryProfit).toHaveAccessibleName('Entry Arb Profit $0.79 USDC');
    expect(responsiveEntryProfit).toHaveAccessibleDescription(/Simulated paper placement snapshot; Simulated placement fills; captured 2026-08-08T16:00:00.000Z/);
    responsiveEntryProfit.focus();
    expect(responsiveEntryProfit).toHaveFocus();
    expect(responsiveEntryProfit.className).toContain('focus-visible:ring');
  });

  it('shows exact backend Entry Arb Profit unavailability and expanded provenance without fabricating zero', async () => {
    const unavailableReason = 'Entry Arb Profit unavailable: authoritative fee is missing for one or both entry legs';
    const unavailablePosition = {
      ...positions[0],
      entryArbProfitSnapshot: {
        version: 1 as const,
        status: 'unavailable' as const,
        reasonCode: 'authoritative_entry_fee_missing' as const,
        reason: unavailableReason,
        executionMode: 'paper' as const,
        provenance: 'historical_backfill' as const,
        capturedAt: '2026-08-19T11:00:00.000Z',
      },
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [unavailablePosition] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    const market = await screen.findByRole('link', { name: 'Open Trump 2026 market' });
    const entryCell = Array.from(market.closest('tr')!.querySelectorAll('td'))[9];
    expect(entryCell.textContent).toBe('Unavailable');
    expect(entryCell.textContent).not.toContain('$0.00');
    expect(entryCell.getAttribute('title')).toBe(unavailableReason);
    expect(entryCell).toHaveAccessibleName('Entry Arb Profit unavailable');
    expect(entryCell).toHaveAccessibleDescription(unavailableReason);
    const responsiveEntryProfit = screen.getByTestId('responsive-entry-arb-profit');
    expect(responsiveEntryProfit).toHaveAccessibleName('Entry Arb Profit unavailable');
    expect(responsiveEntryProfit).toHaveAccessibleDescription(unavailableReason);
    responsiveEntryProfit.focus();
    expect(responsiveEntryProfit).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Trump 2026' }));
    const detail = screen.getByTestId('entry-arb-profit-detail');
    expect(detail.textContent).toContain(unavailableReason);
    expect(detail.textContent).toContain('Historical backfill');
    expect(detail.textContent).toContain('Simulated paper position');
  });

  it('fails closed when an available Entry Arb Profit envelope has malformed provenance fields', async () => {
    const malformedReason = 'Entry Arb Profit unavailable: placement snapshot is malformed';
    const malformedPositions = [{
      ...positions[0],
      id: 2,
      executionId: 10,
      marketTitle: 'Invalid execution mode',
      entryArbProfitSnapshot: { ...positions[0].entryArbProfitSnapshot, executionMode: 'preview' },
    }, {
      ...positions[0],
      id: 3,
      executionId: 11,
      marketTitle: 'Invalid provenance',
      entryArbProfitSnapshot: { ...positions[0].entryArbProfitSnapshot, provenance: 'estimated_current_prices' },
    }, {
      ...positions[0],
      id: 4,
      executionId: 12,
      marketTitle: 'Invalid captured timestamp',
      entryArbProfitSnapshot: { ...positions[0].entryArbProfitSnapshot, capturedAt: 'not-an-instant' },
    }];
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: {
        ...analytics,
        positions: malformedPositions,
        performance: { ...analytics.performance, positionIds: [2, 3, 4] },
      } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    await screen.findByText('Invalid execution mode');
    for (const marketTitle of ['Invalid execution mode', 'Invalid provenance', 'Invalid captured timestamp']) {
      const row = screen.getByText(marketTitle).closest('tr')!;
      const entryCell = Array.from(row.querySelectorAll('td'))[9];
      expect(entryCell.textContent).toBe('Unavailable');
      expect(entryCell).toHaveAccessibleDescription(malformedReason);
      expect(row.querySelector('[data-testid="responsive-entry-arb-profit"]')).toHaveAccessibleDescription(malformedReason);
    }

    fireEvent.click(screen.getByRole('button', { name: 'Expand Invalid provenance' }));
    const detail = screen.getByTestId('entry-arb-profit-detail');
    expect(detail.textContent).toContain(malformedReason);
    expect(detail.textContent).not.toContain('estimated current prices');
  });

  it('fails closed when an unavailable Entry Arb Profit envelope has a noncanonical reason code', async () => {
    const invalidUnavailable = {
      ...positions[0],
      entryArbProfitSnapshot: {
        version: 1 as const,
        status: 'unavailable' as const,
        reasonCode: 'use_current_roi_instead',
        reason: 'Fabricated unavailable reason',
        executionMode: 'paper' as const,
        provenance: 'historical_backfill' as const,
        capturedAt: '2026-08-19T11:00:00.000Z',
      },
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [invalidUnavailable] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    const row = (await screen.findByText('Trump 2026')).closest('tr')!;
    const entryCell = Array.from(row.querySelectorAll('td'))[9];
    expect(entryCell.textContent).toBe('Unavailable');
    expect(entryCell).toHaveAccessibleDescription('Entry Arb Profit unavailable: placement snapshot is malformed');
    expect(entryCell).not.toHaveAccessibleDescription('Fabricated unavailable reason');
  });

  it('rounds negative and zero Entry Arb Profit only for display while preserving direction styling', async () => {
    const negative = {
      ...positions[0],
      id: 2,
      executionId: 10,
      marketTitle: 'Negative entry arb',
      entryArbProfitSnapshot: { ...positions[0].entryArbProfitSnapshot, profitMicrousd: -5_000 },
    };
    const zero = {
      ...positions[0],
      id: 3,
      executionId: 11,
      marketTitle: 'Zero entry arb',
      entryArbProfitSnapshot: { ...positions[0].entryArbProfitSnapshot, profitMicrousd: 0 },
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: {
        ...analytics,
        positions: [negative, zero],
        performance: { ...analytics.performance, positionIds: [2, 3] },
      } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    const negativeCell = Array.from((await screen.findByText('Negative entry arb')).closest('tr')!.querySelectorAll('td'))[9];
    const zeroCell = Array.from(screen.getByText('Zero entry arb').closest('tr')!.querySelectorAll('td'))[9];
    expect(negativeCell.textContent).toBe('-$0.01');
    expect(negativeCell.className).toContain('status-negative');
    expect(zeroCell.textContent).toBe('$0.00');
    expect(zeroCell.className).toContain('text-primary');
  });

  it('shows exact audited outcomes before side while keeping invalid legacy valuation unavailable', async () => {
    const invalid = {
      ...positions[0],
      outcomeIdentityStatus: 'unresolved',
      kalshiOutcomeLabel: 'Republican',
      pmOutcomeLabel: 'Republican',
      propositionRelationshipState: 'same_direction_invalid',
      propositionRelationshipWarning: 'Both exact requested contracts select Republican and use the YES side.',
      kalshiSide: 'yes',
      pmSide: 'yes',
      currentValueCents: null,
      unrealizedPnlCents: null,
      unrealizedRoiBps: null,
      valuationStatus: 'unavailable',
      valuationFailureReason: 'Immutable execution-time Polymarket entry token is missing from the position row',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [invalid] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    const row = (await screen.findByText('Trump 2026')).closest('tr')!;
    expect(Array.from(row.querySelectorAll('td'))[2].textContent).toBe('Outcome unavailable');
    expect(Array.from(row.querySelectorAll('td'))[4].textContent).toBe('Kalshi YESPM YES');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Trump 2026' }));
    expect(screen.getByTestId('kalshi-entry-cost').textContent).toContain('Kalshi YES entry');
    expect(screen.getByTestId('polymarket-entry-cost').textContent).toContain('Polymarket YES entry');
    expect(screen.getByTestId('kalshi-entry-cost').textContent).not.toContain('Republican');
    expect(screen.getByTestId('polymarket-entry-cost').textContent).not.toContain('Republican');
    expect(screen.getAllByText('Immutable execution-time Polymarket entry token is missing from the position row').length).toBeGreaterThan(0);
  });

  it('maps buy cost, indicative current value, P&L, and percentage ROI into their labelled columns', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    stubInitialFetch();
    render(<BotTraderPanel />);

    const marketLink = await screen.findByRole('link', { name: 'Open Trump 2026 market' });
    const row = marketLink.closest('tr');
    expect(row).toBeTruthy();
    const cells = Array.from(row!.querySelectorAll('td')).map((cell) => cell.textContent?.trim());
    expect(cells).toHaveLength(12);
    expect(cells[5]).toBe('$0.97');
    expect(cells[6]).toBe('$1.02');
    expect(cells[7]).toBe('+$0.05');
    expect(cells[8]).toBe('+5.2%');
  });

  it('keeps indicative P&L and ROI visible for stale marks', async () => {
    vi.setSystemTime(new Date('2026-08-11T14:00:01.000Z'));
    stubInitialFetch();
    render(<BotTraderPanel />);

    const marketLink = await screen.findByRole('link', { name: 'Open Trump 2026 market' });
    const cells = Array.from(marketLink.closest('tr')!.querySelectorAll('td')).map((cell) => cell.textContent?.trim());
    expect(cells[5]).toBe('$0.97');
    expect(cells[6]).toBe('$1.02 · Stale');
    expect(cells[7]).toBe('+$0.05');
    expect(cells[8]).toBe('+5.2%');
    expect(cells[7]).not.toContain('executable');
  });

  it('shows unavailable open marks and safely suppresses ROI when buy cost is zero', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    const unavailablePosition = { ...positions[0], totalCostCents: 0, currentValueCents: null, unrealizedPnlCents: null, unrealizedRoiBps: null, lastValuationAt: null };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [unavailablePosition] } });
      if (url.includes('/positions')) return response({
        success: true,
        positions: [unavailablePosition],
      });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    const marketLink = await screen.findByRole('link', { name: 'Open Trump 2026 market' });
    const cells = Array.from(marketLink.closest('tr')!.querySelectorAll('td')).map((cell) => cell.textContent?.trim());
    expect(cells[5]).toBe('$0.00');
    expect(cells[6]).toBe('Valuation unavailable: no executable mark has been recorded');
    expect(cells[7]).toBe('Valuation unavailable: no executable mark has been recorded');
    expect(cells[8]).toBe('Valuation unavailable: no executable mark has been recorded');
  });

  it('shows the exact per-leg valuation blocker instead of generic Unavailable', async () => {
    const unavailablePosition = {
      ...positions[0], currentValueCents: null, lastValuationAt: '2026-08-11T13:45:00.000Z',
      valuationStatus: 'unavailable',
      valuationFailureReason: 'Kalshi: insufficient executable depth (0.5 available, 1 required)',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [unavailablePosition] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Trump 2026' }));
    expect(screen.getAllByText('Kalshi: insufficient executable depth (0.5 available, 1 required)')).toHaveLength(3);
    expect(screen.getByText('Liquidation breakdown: Kalshi: insufficient executable depth (0.5 available, 1 required)')).toBeTruthy();
  });

  it('expands position details from a keyboard-reachable row control', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);

    const expand = await screen.findByRole('button', { name: 'Expand Trump 2026' });
    fireEvent.click(expand);

    expect(screen.getByText('KXTRUMP-26')).toBeTruthy();
    expect(screen.getByText('0xabc')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse Trump 2026' })).toBeTruthy();
    expect(screen.getByTestId('kalshi-entry-cost').textContent).toContain('1 unit');
    expect(screen.getByTestId('kalshi-entry-cost').textContent).toContain('45.000000¢ exact fill');
    expect(screen.getByTestId('combined-entry-cost').textContent).toBe('Reconciled Buy Cost$0.97000000');
    expect(screen.getByTestId('kalshi-entry-cost').textContent).toContain('Kalshi Republicans — YES entry');
    expect(screen.getByTestId('polymarket-entry-cost').textContent).toContain('Polymarket Republicans — NO entry');
    expect(screen.getByTestId('kalshi-stored-current-price').textContent).toContain('Kalshi Republicans — YES Current PriceSaved$0.47');
    expect(screen.getByTestId('polymarket-stored-current-price').textContent).toContain('Polymarket Republicans — NO Current PriceStale$0.55');
    expect(screen.getAllByText(/Indicative last-scanned mark; not executable liquidation proceeds/)).toHaveLength(2);
    expect(screen.getByTestId('kalshi-fee-authority').textContent).toContain('quadratic:1000000:v1');
    expect(screen.getByTestId('polymarket-fee-authority').textContent).toContain('token-fee-rate:400');
  });

  it('renders authoritative entry economics losslessly and visibly reconciles them to Buy Cost', async () => {
    const precisePosition = {
      ...positions[0],
      sharesKalshi: 3,
      kalshiEntryGrossMicrocents: 12_345_679,
      pmEntryGrossMicrocents: 85_012_344,
      kalshiEntryFeeCents: 1,
      pmEntryFeeCents: 0,
      kalshiEntryFills: [
        { priceMicrocents: 4_000_000, sizeMicrounits: 1_000_000 },
        { priceMicrocents: 4_345_679, sizeMicrounits: 1_000_000 },
        { priceMicrocents: 4_000_000, sizeMicrounits: 1_000_000 },
      ],
      pmEntryFills: [{ priceMicrocents: 85_012_344, sizeMicrounits: 1_000_000 }],
      entryCostRoundingDeltaMicrocents: -358_023,
      totalCostCents: 98,
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [precisePosition] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Trump 2026' }));

    expect(screen.getByText('Buy Price').parentElement?.textContent).toContain('YES 4.115226¢ K');
    expect(screen.getByText('Buy Price').parentElement?.textContent).toContain('NO 85.012344¢ PM');
    expect(screen.getByText('Buy Price').parentElement?.textContent).not.toContain('$0.45');
    expect(screen.getByTestId('kalshi-entry-cost').textContent).toContain('3 units · 4.115226¢ rounded VWAP · $0.12345679 gross');
    expect(screen.getByTestId('kalshi-entry-cost').textContent).not.toContain('exact fill');
    expect(screen.getByTestId('kalshi-entry-cost').textContent).toContain('$0.01000000 execution fee · $0.13345679 net leg cost');
    expect(screen.getByTestId('polymarket-entry-cost').textContent).toContain('85.012344¢ exact fill · $0.85012344 gross');
    expect(screen.getByTestId('polymarket-entry-cost').textContent).toContain('$0.00000000 execution fee · $0.85012344 net leg cost');
    expect(screen.getByTestId('entry-cost-reconciliation').textContent).toContain('Currency rounding delta: -$0.00358023');
    expect(screen.getByTestId('entry-cost-reconciliation').textContent).toContain('Gross fills $0.97358023');
    expect(screen.getByTestId('entry-cost-reconciliation').textContent).toContain('Entry fees: Kalshi $0.01000000 · Polymarket $0.00000000');
    expect(screen.getByTestId('combined-entry-cost').textContent).toBe('Reconciled Buy Cost$0.98000000');
    expect(screen.getByTestId('kalshi-entry-fills').textContent).toContain('Fill 1: 1.000000 units @ 4.000000¢');
    expect(screen.getByTestId('kalshi-entry-fills').textContent).toContain('Fill 2: 1.000000 units @ 4.345679¢');
    expect(screen.getByTestId('kalshi-entry-fills').textContent).toContain('Fill 3: 1.000000 units @ 4.000000¢');
    expect(screen.getByTestId('polymarket-entry-fills').textContent).toContain('Fill 1: 1.000000 units @ 85.012344¢');
  });

  it('shows a recovered legacy Buy Cost without inventing a per-platform fee split', async () => {
    const recoveredLegacy = {
      ...positions[0],
      totalCostCents: 96,
      feesCents: 1,
      kalshiEntryGrossMicrocents: 40_000_000,
      pmEntryGrossMicrocents: 55_000_000,
      kalshiEntryFeeCents: 0,
      pmEntryFeeCents: 0,
      unallocatedEntryFeeCents: 1,
      kalshiEntryFills: [{ priceMicrocents: 40_000_000, sizeMicrounits: 1_000_000, authority: 'persisted_position_aggregate' as const }],
      pmEntryFills: [{ priceMicrocents: 55_000_000, sizeMicrounits: 1_000_000, authority: 'persisted_position_aggregate' as const }],
      entryRecordVersion: 1,
      entryRecordSource: 'persisted_position',
      entryRecordedAt: '2026-08-14T10:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [recoveredLegacy] } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);
    await screen.findByText('Trump 2026');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Trump 2026' }));

    expect(screen.getByTestId('combined-entry-cost').textContent).toBe('Reconciled Buy Cost$0.96000000');
    expect(screen.getByTestId('entry-cost-reconciliation').textContent)
      .toContain('Entry fees: $0.01000000 legacy aggregate; platform split unavailable');
    expect(screen.getByTestId('entry-cost-reconciliation').textContent)
      .toContain('Evidence: persisted_position at 2026-08-14T10:00:00.000Z');
    expect(screen.getAllByText('Platform fee allocation unavailable for this legacy entry')).toHaveLength(2);
    expect(screen.getByTestId('kalshi-entry-fills').textContent).toContain('Persisted aggregate: 1.000000 units @ 40.000000¢');
    expect(screen.getByTestId('polymarket-entry-fills').textContent).toContain('Persisted aggregate: 1.000000 units @ 55.000000¢');
    expect(screen.queryByText(/Buy Cost unavailable/)).toBeNull();
  });

  it('shows a specific unavailable Buy Cost reason for legacy paper positions and never displays zero', async () => {
    const legacy = {
      ...positions[0],
      lastValuationAt: new Date().toISOString(),
      entryCostStatus: 'unavailable',
      entryCostFailureReason: 'Legacy paper position lacks authoritative entry fill and fee data',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: {
        ...analytics,
        positions: [legacy],
        performance: { ...analytics.performance, positionIds: [1], capital: { ...analytics.performance.capital, deployedCents: null }, entryCost: { available: 0, unavailable: 1 } },
      } });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 0, todayStakeUsd: 0 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);
    const row = (await screen.findByText('Trump 2026')).closest('tr')!;
    expect(Array.from(row.querySelectorAll('td'))[5].textContent).toBe('Unavailable');
    expect(Array.from(row.querySelectorAll('td'))[6].textContent).toBe('$1.02');
    expect(Array.from(row.querySelectorAll('td'))[7].textContent).toContain('Buy Cost unavailable:');
    expect(Array.from(row.querySelectorAll('td'))[8].textContent).toContain('Buy Cost unavailable:');
    expect(Array.from(row.querySelectorAll('td'))[7].textContent).not.toContain('+$0.05');
    expect(Array.from(row.querySelectorAll('td'))[8].textContent).not.toContain('+5.2%');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Trump 2026' }));
    expect(screen.getAllByText('Buy Cost unavailable: Legacy paper position lacks authoritative entry fill and fee data')).toHaveLength(3);
    expect(screen.getByText('Buy Price').parentElement?.textContent).toBe('Buy PriceUnavailable — authoritative fill evidence missing');
    expect(screen.getByText('Deployed').parentElement?.textContent).toBe('DeployedUnavailable');
  });

  it('keeps summary cards, chart, and rows on the exact same execution mode population', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    const mixedPositions = [
      { ...positions[0], id: 1, marketTitle: 'Paper open profit' },
      { ...positions[0], id: 2, marketTitle: 'Prod open loss', dryRun: false, totalCostCents: 100, currentValueCents: 80 },
    ];
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) {
        const production = url.includes('mode=production');
        return response({ success: true, analytics: production ? {
          ...analytics,
          positions: mixedPositions.filter((position) => !position.dryRun),
          totalBotTrades: { paper: 0, production: 1, total: 1 },
          openPositions: { count: 1 },
          settledPositions: { count: 0, winRateBps: 0 },
          performance: {
            positionIds: [2],
            capital: { deployedCents: 100, currentCents: 80, heldToResolutionCents: 100 },
            pnl: { realizedCents: 0, unrealizedCents: -20, totalCents: -20, roiBps: -2000 },
            valuation: { fresh: 1, stale: 0, unavailable: 0, pendingSettlement: 0, asOf: positions[0].lastValuationAt },
            entryCohorts: [{ date: '2026-08-08', deployedCents: 100, currentCents: 80, heldToResolutionCents: 100, realizedCents: 0, unrealizedCents: -20, trades: 1 }],
          },
        } : { ...analytics, positions: mixedPositions.filter((position) => position.dryRun) } });
      }
      if (url.includes('/positions')) return response({ success: true, positions: mixedPositions });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);
    await screen.findByText('Paper open profit');

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter position mode' }), { target: { value: 'production' } });
    await screen.findByText('Prod open loss');
    expect(screen.queryByText('Paper open profit')).toBeNull();
    expect(screen.getByText('Verified trades').parentElement?.textContent).toBe('Verified trades1');
    expect(screen.getByText('Deployed').parentElement?.textContent).toBe('Deployed$1.00');
    expect(screen.getByText('Indicative value').parentElement?.textContent).toBe('Indicative value$0.80');
    expect(screen.getByText('Unrealized').parentElement?.textContent).toBe('Unrealized-$0.20');
    expect(screen.getByText('Realized').parentElement?.textContent).toBe('Realized$0.00');
    expect(screen.getByText('Total P&L').parentElement?.textContent).toBe('Total P&L-$0.20');
    expect(screen.getByRole('img', { name: 'BotTrader current performance by entry date chart' })).toBeTruthy();
  });

  it('expands authoritative per-leg gross, fee, and net proceeds that sum to Current Value', async () => {
    vi.setSystemTime(new Date('2026-08-11T13:45:00.000Z'));
    const feePosition = {
      ...positions[0],
      sharesKalshi: 10,
      sharesPm: 10,
      totalCostCents: 978,
      currentPriceKalshiCents: 46,
      currentPricePmCents: 55,
      kalshiGrossProceedsMicrocents: 455_000_000,
      pmGrossProceedsMicrocents: 550_000_000,
      kalshiNetProceedsCents: 437,
      pmNetProceedsCents: 540,
      kalshiExitFeeCents: 18,
      pmExitFeeCents: 10,
      currentValueCents: 977,
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/analytics')) return response({ success: true, analytics: { ...analytics, positions: [feePosition] } });
      if (url.includes('/positions')) return response({ success: true, positions: [feePosition] });
      if (url.includes('/status')) return response({ enabled: false, mode: 'paper', selectionMethod: 'hybrid', todayCount: 2, todayStakeUsd: 10.5 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BotTraderPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Trump 2026' }));
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('10 held');
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('45.500¢ VWAP');
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('$4.55 gross');
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('$0.18 fee');
    expect(screen.getByTestId('kalshi-liquidation').textContent).toContain('$4.37 net');
    expect(screen.getByTestId('polymarket-liquidation').textContent).toContain('4.00%');
    expect(screen.getByTestId('polymarket-liquidation').textContent).toContain('$5.40 net');
    expect(screen.getByTestId('combined-net-proceeds').textContent).toBe('Combined net proceeds$9.77');
    expect(screen.getByTestId('combined-net-proceeds').textContent).toContain('$9.77');
  });

  it('renders rows from the same filtered analytics snapshot as cards and chart', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);
    await screen.findByText('Trump 2026');

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter position mode' }), { target: { value: 'production' } });
    expect(await screen.findByText('No verified BotTrader positions for these filters.')).toBeTruthy();
    expect(screen.queryByText('Trump 2026')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/positions'))).toHaveLength(0);
  });

  it('requires exact production confirmation and forwards it to the gated settings API', async () => {
    stubInitialFetch();
    render(<BotTraderPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Production' }));

    const confirmation = screen.getByRole('textbox', { name: 'Production confirmation' });
    const submit = screen.getByRole('button', { name: 'Confirm production' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(confirmation, { target: { value: 'PRODUCTION' } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      const settingsCall = vi.mocked(fetch).mock.calls.find((call: [unknown, RequestInit?]) => String(call[0]) === '/api/settings');
      expect(settingsCall).toBeTruthy();
      expect(JSON.parse(String(settingsCall?.[1]?.body))).toEqual({
        values: { 'bot.mode': 'production' },
        confirmation: 'PRODUCTION',
      });
    });
  });
});
