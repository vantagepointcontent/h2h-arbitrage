'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import BotActionLogs from './BotActionLogs';
import BotTraderMessages from './BotTraderMessages';
import { updateSettingsFromBrowser } from '@/app/actions/bot-trader-mutations';
import { projectOpenPositionPnlCents } from '@/lib/bot-position-financials';

type PositionStatus = 'open' | 'settled' | 'closed';
type SettlementState = 'open' | 'partially_settled' | 'settlement_pending' | 'settlement_unresolved' | 'settled';
type PositionFilter = 'all' | 'open' | 'settled';
type PositionModeFilter = 'paper' | 'production';
type PerformanceMethod = 'all' | 'roi' | 'apy' | 'hybrid' | 'legacy';
type PerformanceRange = 'today' | '7d' | '30d' | '90d' | 'all';
type SortKey = 'openedAt' | 'pnl' | 'roi';
type SortDirection = 'asc' | 'desc';
type RelationshipValidity = 'verified_complementary' | 'confirmed_invalid' | 'unresolved_relationship' | 'non_exhaustive_conflicting';
type ExposureIdentityVerdict = 'exact_held_legs_proven' | 'partially_proven' | 'no_fill_rolled_back' | 'unrecoverable';

interface LegacyExposureVerdict {
  version: 1;
  relationshipValidity: RelationshipValidity;
  exposureIdentity: ExposureIdentityVerdict;
  valuationClass: 'verified_arbitrage' | 'invalid_unverified_exposure' | 'unavailable';
  executionMode: 'paper' | 'live';
  simulated: boolean;
  exactLegs: {
    kalshi: { marketId: string | null; tokenId: null; side: 'yes' | 'no'; requestedQuantity: number | null; filledQuantity: number | null; orderId: string | null; marketQuestion: string | null; outcomeLabel: string | null };
    polymarket: { marketId: string | null; tokenId: string | null; side: 'yes' | 'no'; requestedQuantity: number | null; filledQuantity: number | null; orderId: string | null; marketQuestion: string | null; outcomeLabel: string | null };
  };
  reason: string;
  evidence: Array<{ source: string; revision: string; capturedAt: string; confidence: 'canonical' | 'exact_immutable_execution' | 'fingerprinted_audit' }>;
  excludedFromVerifiedTotals: boolean;
  tradeAuthorization: 'denied';
  closeAuthorization: 'denied';
  revision: string;
}

interface StoredPriceSnapshot {
  status: 'available' | 'stale' | 'unavailable' | 'missing_identifier' | 'side_mismatch' | 'never_saved';
  priceCents: number | null;
  source: string | null;
  observedAt: string | null;
  ageMs: number | null;
  executableDepthMicros?: number | null;
  failureReason?: string | null;
  markFailureReason?: string | null;
  identity?: { platform: 'kalshi' | 'polymarket'; marketId: string | null; side: 'yes' | 'no'; tokenId: string | null };
}

type EntryArbProfitSnapshot = {
  version: 1;
  executionMode: 'paper' | 'live';
  capturedAt: string;
  provenance: 'simulated_placement_fills' | 'authoritative_venue_fills' | 'placement_snapshot' | 'historical_backfill';
} & ({
  status: 'available';
  profitMicrousd: number;
  currency: 'USDC';
  monetaryUnit: 'microusd';
} | {
  status: 'unavailable';
  reasonCode: string;
  reason: string;
});

interface BotPosition {
  id: number;
  executionId: number;
  marketId: string | null;
  marketTitle: string;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  kalshiUrl: string | null;
  polymarketUrl: string | null;
  strategy: string | null;
  kalshiMarketQuestion?: string | null;
  pmMarketQuestion?: string | null;
  kalshiOutcomeLabel?: string | null;
  pmOutcomeLabel?: string | null;
  outcomeIdentityStatus?: 'verified' | 'unresolved';
  outcomeIdentitySource?: string | null;
  outcomeIdentityRecordedAt?: string | null;
  outcomeIdentityFailureReason?: string | null;
  pmEntryTokenId?: string | null;
  relationshipValidity?: RelationshipValidity;
  exposureIdentityStatus?: ExposureIdentityVerdict;
  legacyExposureVerdict?: LegacyExposureVerdict | null;
  legacyExposureRevision?: string | null;
  legacyExposureRunId?: string | null;
  exposureValuationLabel?: 'Verified arbitrage' | 'Invalid/unverified exposure' | 'Unavailable';
  excludedFromVerifiedTotals?: boolean;
  propositionRelationship?: {
    humanLabel: string;
    legs: { kalshi: { humanLabel: string }; polymarket: { humanLabel: string } };
  } | null;
  propositionRelationshipState?: 'verified_complementary' | 'same_direction_invalid' | 'invalid_metadata' | 'non_exhaustive' | 'unknown';
  propositionRelationshipWarning?: string | null;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
  buyPriceKalshiCents: number;
  buyPricePmCents: number;
  sharesKalshi: number;
  sharesPm: number;
  remainingSharesKalshi?: number;
  remainingSharesPm?: number;
  remainingOpenCostCents?: number;
  totalCostCents: number;
  entryCostStatus?: 'available' | 'unavailable';
  entryCostFailureReason?: string | null;
  kalshiEntryGrossMicrocents?: number | null;
  pmEntryGrossMicrocents?: number | null;
  kalshiEntryFeeCents?: number;
  pmEntryFeeCents?: number;
  unallocatedEntryFeeCents?: number;
  entryRecordVersion?: number | null;
  entryRecordSource?: string | null;
  entryRecordedAt?: string | null;
  entryCostRoundingDeltaMicrocents?: number | null;
  entryArbProfitSnapshot?: EntryArbProfitSnapshot;
  kalshiEntryFillCount?: number | null;
  pmEntryFillCount?: number | null;
  kalshiEntryFills?: Array<{ priceMicrocents: number; sizeMicrounits: number; authority?: 'persisted_position_aggregate' }> | null;
  pmEntryFills?: Array<{ priceMicrocents: number; sizeMicrounits: number; authority?: 'persisted_position_aggregate' }> | null;
  expectedPayoutCents: number;
  expectedProfitCents: number;
  feesCents: number;
  status: PositionStatus;
  openedAt: string;
  expiryDate: string | null;
  settledAt: string | null;
  currentPriceKalshiCents: number | null;
  currentPricePmCents: number | null;
  currentPriceSnapshots?: { kalshi: StoredPriceSnapshot; polymarket: StoredPriceSnapshot };
  currentValueCents: number | null;
  indicativeValueMicrocents?: number | null;
  indicativePnlMicrocents?: number | null;
  indicativeBuyCostMicrocents?: number | null;
  kalshiGrossProceedsMicrocents: number | null;
  pmGrossProceedsMicrocents: number | null;
  kalshiNetProceedsCents: number | null;
  pmNetProceedsCents: number | null;
  kalshiExitFeeCents: number | null;
  pmExitFeeCents: number | null;
  kalshiExitFeeType: 'quadratic' | null;
  kalshiExitFeeMultiplierPpm: number | null;
  kalshiExitFeeSource?: string | null;
  kalshiExitFeeObservedAt?: string | null;
  kalshiExitFeeVersion?: string | null;
  pmExitFeeRateBps: number | null;
  pmExitFeeSource?: string | null;
  pmExitFeeObservedAt?: string | null;
  pmExitFeeVersion?: string | null;
  unrealizedPnlCents: number | null;
  unrealizedRoiBps: number | null;
  lastValuationAt: string | null;
  valuationStatus?: 'current' | 'stale' | 'unavailable';
  valuationFailureReason?: string | null;
  realizedPnlBeforeSettlementCents?: number | null;
  realizedPnlCents: number | null;
  settlementSide: 'kalshi' | 'pm' | null;
  resolutionPayoutCents?: number | null;
  resolutionValidationStatus?: 'pending' | 'verified' | 'invalid';
  settlementState?: SettlementState;
  settlementGrossProceedsCents?: number | null;
  settlementNetProceedsCents?: number | null;
  settlementFailureReason?: string | null;
  settlementCashAvailableAt?: string | null;
  settlementReconciledAt?: string | null;
  realizedRoiBps?: number | null;
  settlementLegs?: Array<{
    venue: 'kalshi' | 'polymarket'; lifecycleState: string; marketId: string | null;
    outcomeId: string | null; side: 'yes' | 'no'; filledQuantity: number | null;
    resolutionWinningSide: 'yes' | 'no' | null; resolutionDetectedAt: string | null;
    resolutionSource: string | null; payoutEntitlementCents: number | null;
    settlementFeeCents: number | null; netSettlementProceedsCents: number | null;
    creditState: string; cashAvailableAt: string | null; failureReason: string | null;
  }>;
  dryRun: boolean;
  selectionMethod: 'roi' | 'apy' | 'hybrid' | null;
}

export function positionRoiBps(position: Pick<BotPosition, 'status' | 'totalCostCents' | 'realizedPnlCents' | 'unrealizedRoiBps'>): number | null {
  if (position.totalCostCents <= 0) return null;
  if (position.status === 'open') return position.unrealizedRoiBps;
  if (position.realizedPnlCents == null) return null;
  return Math.round((position.realizedPnlCents * 10_000) / position.totalCostCents);
}

const VALUATION_STALE_MS = 15 * 60_000;

type OpenMark =
  | { available: true; fresh: boolean; warning: string | null; currentValueCents: number; pnlCents: number; roiBps: number | null }
  | { available: false; label: string };

function openPositionMark(position: BotPosition, now = Date.now()): OpenMark {
  if (position.currentValueCents == null || !position.lastValuationAt) {
    return { available: false, label: position.valuationFailureReason?.trim() || 'Valuation unavailable: no executable mark has been recorded' };
  }
  const observedAt = Date.parse(position.lastValuationAt);
  if (!Number.isFinite(observedAt)) return { available: false, label: position.valuationFailureReason?.trim() || 'Valuation unavailable: malformed quote timestamp' };
  const warning = position.valuationFailureReason?.trim()
    || (now - observedAt > VALUATION_STALE_MS ? 'Stale last-scanned mark' : null);
  const openCostCents = Number.isSafeInteger(position.remainingOpenCostCents)
    ? position.remainingOpenCostCents!
    : position.totalCostCents;
  const markCostCents = Number.isSafeInteger(position.indicativeBuyCostMicrocents)
    ? position.totalCostCents
    : openCostCents;
  const pnlCents = projectOpenPositionPnlCents({
    currentValueCents: position.currentValueCents,
    buyCostCents: markCostCents,
    indicativePnlMicrocents: position.indicativePnlMicrocents,
    realizedPnlCents: position.realizedPnlCents,
  });
  if (pnlCents == null) {
    return { available: false, label: position.valuationFailureReason?.trim() || 'Valuation unavailable: malformed persisted P&L inputs' };
  }
  return {
    available: true,
    fresh: warning == null,
    warning,
    currentValueCents: position.currentValueCents,
    pnlCents,
    roiBps: markCostCents > 0 ? Math.round((pnlCents * 10_000) / markCostCents) : null,
  };
}

function hasVerifiedTerminalAccounting(position: BotPosition): boolean {
  const openCostCents = Number.isSafeInteger(position.remainingOpenCostCents)
    ? position.remainingOpenCostCents!
    : position.totalCostCents;
  const knownPartialReduction = Number.isSafeInteger(position.remainingSharesKalshi)
    && Number.isSafeInteger(position.remainingSharesPm)
    && (position.remainingSharesKalshi !== position.sharesKalshi
      || position.remainingSharesPm !== position.sharesPm);
  const realizedBeforeSettlement = Number.isSafeInteger(position.realizedPnlBeforeSettlementCents)
    ? position.realizedPnlBeforeSettlementCents!
    : knownPartialReduction ? null : 0;
  return position.status !== 'open'
    && position.resolutionValidationStatus === 'verified'
    && Number.isSafeInteger(position.resolutionPayoutCents)
    && Number.isSafeInteger(position.realizedPnlCents)
    && realizedBeforeSettlement != null
    && realizedBeforeSettlement + position.resolutionPayoutCents! - openCostCents === position.realizedPnlCents;
}


interface BotStatus {
  enabled: boolean;
  botStatus: 'ON' | 'OFF' | 'Blocked';
  paperBlockedReasons?: string[];
  mode: 'paper' | 'production';
  selectionMethod: 'roi' | 'apy' | 'hybrid';
  todayCount: number;
  todayStakeUsd: number;
  workflow?: {
    health: 'healthy' | 'degraded';
    degradedReasons: string[];
    liveUnavailableReasons: string[];
    effectiveExecutionMode: 'paper' | 'live';
    requestedExecutionMode: 'paper' | 'production';
    liveAuthorizationConfigured: boolean;
    credentialsReady: boolean;
    latestCompletedScanId: number | null;
    latestCompletedScanAt: string | null;
    cursorScanId: number;
    pendingScans: number;
    cursorLag: number;
    opportunitiesEvaluated: number;
    eligibleCount: number;
    lastExecutionOrSkip: { scanId: number; state: string; reason: string; at: string } | null;
  };
}

interface PerformanceAnalytics {
  positions: BotPosition[];
  totalBotTrades: { paper: number; production: number; total: number };
  openPositions: { count: number };
  settledPositions: { count: number; winRateBps: number };
  performance: {
    positionIds: number[];
    capital: { deployedCents: number | null; currentCents: number; heldToResolutionCents: number; excludedOpenCostCents: number };
    entryCost?: { available: number; unavailable: number };
    pnl: { realizedCents: number; unrealizedCents: number | null; totalCents: number | null; roiBps: number | null };
    valuation: { fresh: number; stale: number; unavailable: number; pendingSettlement: number; asOf: string | null };
    entryCohorts: Array<{ date: string; deployedCents: number | null; currentCents: number | null; heldToResolutionCents: number; realizedCents: number; unrealizedCents: number | null; trades: number }>;
  };
}

const RANGE_OPTIONS: Array<{ key: PerformanceRange; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: '90d', label: '90 Days' },
  { key: 'all', label: 'All' },
];


const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const PRECISE_USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 8 });
const EXACT_USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 8, maximumFractionDigits: 8 });
const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const THREE_DECIMAL = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const EXACT_CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
const ENTRY_ARB_PROFIT_DESCRIPTION = 'Net profit expected from the verified placed arb if held to settlement, captured at entry';
const ENTRY_ARB_PROFIT_UNAVAILABLE_REASON_CODES = new Set([
  'relationship_not_verified_complementary',
  'exact_outcome_identity_unverified',
  'unmatched_filled_quantities',
  'non_positive_filled_quantity',
  'authoritative_entry_fee_missing',
  'immutable_buy_cost_missing',
  'entry_economics_do_not_reconcile',
  'exact_leg_identity_missing',
]);

function formatCents(cents: number, signed = false): string {
  const value = cents / 100;
  const formatted = USD.format(Math.abs(value));
  if (value < 0) return `-${formatted}`;
  return signed && value > 0 ? `+${formatted}` : formatted;
}

function formatUsd(value: number): string {
  return USD.format(value);
}

function formatBps(bps: number, signed = false): string {
  const value = bps / 100;
  const prefix = signed && value > 0 ? '+' : '';
  return `${prefix}${ONE_DECIMAL.format(value)}%`;
}

function formatMicrocents(microcents: number): string {
  return PRECISE_USD.format(microcents / 100_000_000);
}

function formatExactMicrocents(microcents: number): string {
  return EXACT_USD.format(microcents / 100_000_000);
}

function formatMicrousd(microusd: number): string {
  return USD.format(microusd / 1_000_000);
}

function entryArbProvenanceLabel(snapshot: EntryArbProfitSnapshot): string {
  const labels: Record<EntryArbProfitSnapshot['provenance'], string> = {
    simulated_placement_fills: 'Simulated placement fills',
    authoritative_venue_fills: 'Authoritative venue fills',
    placement_snapshot: 'Placement snapshot',
    historical_backfill: 'Historical backfill',
  };
  return labels[snapshot.provenance];
}

function entryArbProfitPresentation(snapshot: EntryArbProfitSnapshot | undefined) {
  const missingReason = 'Entry Arb Profit unavailable: placement snapshot missing';
  const malformedReason = 'Entry Arb Profit unavailable: placement snapshot is malformed';
  if (!snapshot) return { available: false as const, label: 'Unavailable', reason: missingReason };
  const executionModeValid = snapshot.executionMode === 'paper' || snapshot.executionMode === 'live';
  const capturedAtValid = typeof snapshot.capturedAt === 'string'
    && snapshot.capturedAt.trim().length > 0
    && Number.isFinite(Date.parse(snapshot.capturedAt));
  if (snapshot.version !== 1 || !executionModeValid || !capturedAtValid
      || (snapshot.status !== 'available' && snapshot.status !== 'unavailable')) {
    return { available: false as const, label: 'Unavailable', reason: malformedReason };
  }
  if (snapshot.status === 'unavailable') {
    const provenanceValid = snapshot.provenance === 'placement_snapshot' || snapshot.provenance === 'historical_backfill';
    const reasonCodeValid = typeof snapshot.reasonCode === 'string'
      && ENTRY_ARB_PROFIT_UNAVAILABLE_REASON_CODES.has(snapshot.reasonCode);
    const reason = typeof snapshot.reason === 'string' ? snapshot.reason.trim() : '';
    if (!provenanceValid || !reasonCodeValid || !reason) {
      return { available: false as const, label: 'Unavailable', reason: malformedReason };
    }
    const modeDetail = snapshot.executionMode === 'paper' ? 'Simulated paper position' : 'Authoritative live position';
    return {
      available: false as const,
      label: 'Unavailable',
      reason,
      detail: `${entryArbProvenanceLabel(snapshot)} · ${modeDetail} · captured ${snapshot.capturedAt}`,
    };
  }
  const provenanceValid = snapshot.provenance === 'simulated_placement_fills'
    || snapshot.provenance === 'authoritative_venue_fills';
  const modeMatchesProvenance = snapshot.executionMode === 'paper'
    ? snapshot.provenance === 'simulated_placement_fills'
    : snapshot.provenance === 'authoritative_venue_fills';
  if (!provenanceValid || !modeMatchesProvenance || snapshot.currency !== 'USDC'
      || snapshot.monetaryUnit !== 'microusd' || !Number.isSafeInteger(snapshot.profitMicrousd)) {
    return { available: false as const, label: 'Unavailable', reason: malformedReason };
  }
  const label = formatMicrousd(snapshot.profitMicrousd);
  const modeLabel = snapshot.executionMode === 'paper' ? 'Simulated paper placement snapshot' : 'Authoritative live placement snapshot';
  const detail = `${modeLabel}; ${entryArbProvenanceLabel(snapshot)}; captured ${snapshot.capturedAt}`;
  return {
    available: true as const,
    label,
    value: snapshot.profitMicrousd,
    title: `${ENTRY_ARB_PROFIT_DESCRIPTION}. ${detail}`,
    detail,
  };
}

function formatExactEntryPrice(grossMicrocents: number, quantity: number): string {
  return `${EXACT_CENTS.format(grossMicrocents / 1_000_000 / quantity)}¢`;
}

function entryPricePrecisionLabel(grossMicrocents: number, quantity: number): string {
  return grossMicrocents % quantity === 0 ? 'exact fill' : 'rounded VWAP';
}

function formatVwapCents(grossProceedsMicrocents: number, quantity: number): string {
  return `${THREE_DECIMAL.format(grossProceedsMicrocents / 1_000_000 / quantity)}¢`;
}

function pnlClass(value: number): string {
  if (value > 0) return 'text-[var(--status-positive)]';
  if (value < 0) return 'text-[var(--status-negative)]';
  return 'text-[var(--text-primary)]';
}

function timeAgo(iso: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(iso));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function snapshotStateLabel(snapshot: StoredPriceSnapshot): string {
  const labels: Record<StoredPriceSnapshot['status'], string> = {
    available: 'Saved', stale: 'Stale', unavailable: 'Unavailable',
    missing_identifier: 'Missing identifier', side_mismatch: 'Side/token mismatch', never_saved: 'Never saved',
  };
  return labels[snapshot.status];
}

function MetricCard({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${valueClass || 'text-[var(--text-primary)]'}`}>{value}</div>
    </div>
  );
}

function StatusBadge({ position }: { position: BotPosition }) {
  const styles: Record<PositionStatus | 'pending' | 'unresolved' | 'partial', string> = {
    open: 'bg-[var(--status-positive)]/15 text-[var(--status-positive)]',
    settled: 'bg-[var(--status-positive)]/15 text-[var(--status-positive)]',
    closed: 'bg-[var(--status-negative)]/15 text-[var(--status-negative)]',
    pending: 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]',
    unresolved: 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]',
    partial: 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]',
  };
  const state = position.settlementState;
  const style = state === 'settlement_unresolved' ? 'unresolved'
    : state === 'settlement_pending' ? 'pending'
      : state === 'partially_settled' ? 'partial'
        : position.status;
  const label = state === 'settlement_unresolved' ? 'Settlement unresolved'
    : state === 'settlement_pending' ? 'Settlement pending'
      : state === 'partially_settled' ? 'Partially settled'
        : state === 'settled' || position.status === 'settled'
          ? `Settled${position.dryRun ? ' (paper)' : ''}`
          : position.status;
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${styles[style]}`}>{label}</span>;
}

type ExposureClassification = {
  label: 'Verified arb' | 'Invalid exposure' | 'Relationship unverified' | 'Legacy identity missing' | 'Settlement unresolved' | 'No exposure';
  style: string;
  detail: string;
  reasons: string[];
  evidence: LegacyExposureVerdict['evidence'];
  missingIdentifiers: string[];
  isExposureOnly: boolean;
  excludedFromVerifiedTotals: boolean;
};

function exposureClassification(position: BotPosition, entryArbProfit: ReturnType<typeof entryArbProfitPresentation>): ExposureClassification {
  const verdict = position.legacyExposureVerdict;
  const relationship = position.relationshipValidity ?? verdict?.relationshipValidity;
  const identity = position.exposureIdentityStatus ?? verdict?.exposureIdentity;
  const openMark = position.status === 'open' ? openPositionMark(position) : null;
  let label: ExposureClassification['label'];
  if (position.settlementState === 'settlement_unresolved') label = 'Settlement unresolved';
  else if (identity === 'no_fill_rolled_back') label = 'No exposure';
  else if (identity === 'exact_held_legs_proven' && relationship === 'verified_complementary') label = 'Verified arb';
  else if (identity === 'exact_held_legs_proven' && relationship === 'unresolved_relationship') label = 'Relationship unverified';
  else if (identity === 'exact_held_legs_proven') label = 'Invalid exposure';
  else if (position.propositionRelationshipState === 'verified_complementary') label = 'Verified arb';
  else if (position.propositionRelationshipState && position.propositionRelationshipState !== 'unknown') label = 'Invalid exposure';
  else label = 'Legacy identity missing';

  const styles: Record<ExposureClassification['label'], string> = {
    'Verified arb': 'border-[var(--status-positive)]/40 bg-[var(--status-positive)]/10 text-[var(--status-positive)]',
    'Invalid exposure': 'border-[var(--status-negative)]/50 bg-[var(--status-negative)]/10 text-[var(--status-negative)]',
    'Relationship unverified': 'border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 text-[var(--status-warning)]',
    'Legacy identity missing': 'border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 text-[var(--status-warning)]',
    'Settlement unresolved': 'border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 text-[var(--status-warning)]',
    'No exposure': 'border-[var(--border-strong)] bg-[var(--surface-workspace)] text-[var(--text-secondary)]',
  };
  const reasons = Array.from(new Set([
    verdict?.reason,
    position.settlementFailureReason,
    openMark && !openMark.available ? openMark.label : position.valuationFailureReason,
    position.outcomeIdentityFailureReason,
    position.entryCostFailureReason,
    verdict ? null : position.propositionRelationshipWarning,
    entryArbProfit.available ? null : entryArbProfit.reason,
  ].map((reason) => reason?.trim()).filter((reason): reason is string => Boolean(reason))));
  const missingIdentifiers: string[] = [];
  if (verdict) {
    if (!verdict.exactLegs.kalshi.marketId) missingIdentifiers.push('Kalshi market ID missing');
    if (!verdict.exactLegs.polymarket.marketId) missingIdentifiers.push('Polymarket market ID missing');
    if (!verdict.exactLegs.polymarket.tokenId) missingIdentifiers.push('Polymarket token missing');
  } else {
    if (!position.kalshiTicker) missingIdentifiers.push('Kalshi market ID missing');
    if (!position.pmConditionId) missingIdentifiers.push('Polymarket market ID missing');
    if (!position.pmEntryTokenId) missingIdentifiers.push('Polymarket token missing');
  }
  const excludedFromVerifiedTotals = position.excludedFromVerifiedTotals ?? verdict?.excludedFromVerifiedTotals ?? label !== 'Verified arb';
  const evidence = verdict?.evidence ?? [];
  const isExposureOnly = identity === 'exact_held_legs_proven' && relationship !== 'verified_complementary';
  const detail = [
    label,
    ...reasons,
    evidence.length ? `Evidence provenance: ${evidence.map((item) => `${item.source}, ${item.confidence}, captured ${item.capturedAt}, revision ${item.revision}`).join('; ')}` : 'Evidence provenance unavailable',
    missingIdentifiers.length ? `Missing identifiers: ${missingIdentifiers.join('; ')}` : 'Exact held identifiers recorded',
    excludedFromVerifiedTotals ? 'Excluded from verified-arbitrage totals' : 'Included in verified-arbitrage totals',
    isExposureOnly ? 'Exposure mark-to-market only; not verified-arbitrage analytics or eligibility' : null,
    'Exposure marks never authorize trade or close actions',
  ].filter(Boolean).join('. ');
  return { label, style: styles[label], detail, reasons, evidence, missingIdentifiers, isExposureOnly, excludedFromVerifiedTotals };
}

function ExposureBadge({ classification, testId, className = '' }: { classification: ExposureClassification; testId: string; className?: string }) {
  return <span data-testid={testId} className={`inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase ${classification.style} ${className}`}>{classification.label}</span>;
}

export default function BotTraderPanel() {
  const [view, setView] = useState<'analytics' | 'logs' | 'messages'>('analytics');

  const [positions, setPositions] = useState<BotPosition[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [analytics, setAnalytics] = useState<PerformanceAnalytics | null>(null);
  const [filter, setFilter] = useState<PositionFilter>('all');
  const [modeFilter, setModeFilter] = useState<PositionModeFilter>('paper');
  const [methodFilter, setMethodFilter] = useState<PerformanceMethod>('all');
  const [range, setRange] = useState<PerformanceRange>('30d');
  const [sortKey, setSortKey] = useState<SortKey>('openedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productionConfirmOpen, setProductionConfirmOpen] = useState(false);
  const [productionConfirmation, setProductionConfirmation] = useState('');
  const requestIdRef = useRef(0);
  const mutationIdRef = useRef(0);
  const mutationInFlightRef = useRef(false);

  const load = useCallback(async (initial = false) => {
    const requestId = ++requestIdRef.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [statusRes, analyticsRes] = await Promise.all([
        fetch('/api/bot-trader/status', { cache: 'no-store' }),
        fetch(`/api/bot-trader/analytics?method=${methodFilter}&mode=${modeFilter}&range=${range}`, { cache: 'no-store' }),
      ]);
      const [statusData, analyticsData] = await Promise.all([statusRes.json(), analyticsRes.json()]);
      if (!statusRes.ok) throw new Error(statusData.error || 'Failed to load bot status');
      if (!analyticsRes.ok || !analyticsData.success) throw new Error(analyticsData.error || 'Failed to load performance analytics');
      if (requestId !== requestIdRef.current) return;
      setPositions(analyticsData.analytics.positions ?? []);
      setStatus(statusData);
      setAnalytics(analyticsData.analytics);
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        setError(cause instanceof Error ? cause.message : 'Failed to load BotTrader analytics');
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [methodFilter, modeFilter, range]);

  useEffect(() => {
    const initialId = window.setTimeout(() => void load(true), 0);
    const intervalId = window.setInterval(() => void load(false), 30_000);
    return () => {
      window.clearTimeout(initialId);
      window.clearInterval(intervalId);
    };
  }, [load]);

  const filteredPositions = useMemo(() => {
    const included = new Set(analytics?.performance.positionIds ?? []);
    return positions.filter((position) => {
      if (!included.has(position.id) || filter === 'all') return included.has(position.id);
      const open = position.status === 'open';
      return filter === 'open' ? open : !open;
    });
  }, [analytics, filter, positions]);

  const sortedPositions = useMemo(() => filteredPositions.slice().sort((a, b) => {
    const sortablePnl = (position: BotPosition) => {
      if (position.status !== 'open') {
        return hasVerifiedTerminalAccounting(position) ? position.realizedPnlCents : null;
      }
      const mark = openPositionMark(position);
      return mark.available ? mark.pnlCents : null;
    };
    const sortableRoi = (position: BotPosition) => {
      if (position.status !== 'open' && !hasVerifiedTerminalAccounting(position)) return null;
      if (position.status === 'open') {
        const mark = openPositionMark(position);
        return mark.available ? mark.roiBps : null;
      }
      return positionRoiBps(position);
    };
    const values: Record<SortKey, [number | null, number | null]> = {
      openedAt: [Date.parse(a.openedAt), Date.parse(b.openedAt)],
      pnl: [sortablePnl(a), sortablePnl(b)],
      roi: [sortableRoi(a), sortableRoi(b)],
    };
    const [left, right] = values[sortKey];
    if (left == null || right == null) {
      if (left == null && right == null) return 0;
      return left == null ? 1 : -1;
    }
    return sortDirection === 'asc' ? left - right : right - left;
  }), [filteredPositions, sortDirection, sortKey]);

  const changeSort = (next: SortKey) => {
    if (next === sortKey) setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(next);
      setSortDirection('desc');
    }
  };

  const saveSetting = async (key: 'bot.enabled' | 'bot.mode' | 'bot.selectionMethod', value: boolean | 'paper' | 'production' | 'roi' | 'apy' | 'hybrid', confirmation?: 'PRODUCTION') => {
    if (!status || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    const mutationId = ++mutationIdRef.current;
    let mutationPersisted = false;
    setSaving(true);
    setError(null);
    try {
      const result = await updateSettingsFromBrowser({
        values: { [key]: value },
        ...(confirmation ? { confirmation } : {}),
      });
      if (mutationId !== mutationIdRef.current) return;
      if (!result.ok) {
        setError(result.message || 'BotTrader settings are temporarily unavailable. The previous settings remain active.');
        return;
      }
      mutationPersisted = true;
      const requestId = ++requestIdRef.current;
      setRefreshing(true);
      const statusResponse = await fetch('/api/bot-trader/status', { cache: 'no-store' });
      const canonicalStatus = await statusResponse.json();
      if (!statusResponse.ok) throw new Error('canonical-status-unavailable');
      if (requestId === requestIdRef.current) setStatus(canonicalStatus);
    } catch {
      if (mutationId === mutationIdRef.current) {
        setError(mutationPersisted
          ? 'The setting was saved, but canonical BotTrader status could not be refreshed. Refresh the panel to confirm the active state.'
          : 'BotTrader settings are temporarily unavailable. The previous settings remain active.');
      }
    } finally {
      if (mutationId === mutationIdRef.current) {
        mutationInFlightRef.current = false;
        setRefreshing(false);
        setSaving(false);
      }
    }
  };

  const toggleEnabled = () => {
    if (!status) return;
    if (!status.enabled && !window.confirm(`Enable BotTrader in ${status.mode} mode?`)) return;
    void saveSetting('bot.enabled', !status.enabled);
  };

  const toggleMode = () => {
    if (!status) return;
    if (status.mode === 'production') {
      void saveSetting('bot.mode', 'paper');
      return;
    }
    setProductionConfirmation('');
    setProductionConfirmOpen(true);
  };

  const setRankSource = (source: 'roi' | 'apy', enabled: boolean) => {
    if (!status) return;
    const roiEnabled = status.selectionMethod !== 'apy';
    const apyEnabled = status.selectionMethod !== 'roi';
    const nextRoi = source === 'roi' ? enabled : roiEnabled;
    const nextApy = source === 'apy' ? enabled : apyEnabled;
    if (!nextRoi && !nextApy) return;
    const method = nextRoi && nextApy ? 'hybrid' : nextRoi ? 'roi' : 'apy';
    void saveSetting('bot.selectionMethod', method);
  };

  const changePerformanceFilter = <T,>(current: T, next: T, change: (value: T) => void) => {
    if (current === next) return;
    requestIdRef.current += 1;
    setAnalytics(null);
    setLoading(true);
    change(next);
  };

  if (loading) {
    return <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-[var(--text-secondary)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading BotTrader analytics…</div>;
  }

  if (!analytics) {
    return <div role="alert" className="flex min-h-64 flex-col items-center justify-center gap-2 text-sm text-[var(--status-negative)]"><AlertTriangle className="h-5 w-5" />{error || 'BotTrader performance is unavailable.'}<button onClick={() => void load(true)} className="min-h-11 rounded-lg border border-[var(--border-strong)] px-3 text-xs">Retry</button></div>;
  }

  const performance = analytics.performance;
  const rangeLabel = RANGE_OPTIONS.find((option) => option.key === range)?.label ?? '30 Days';
  const quoteIssueCount = performance.valuation.stale + performance.valuation.unavailable + performance.valuation.pendingSettlement;
  const chartData = performance.entryCohorts.map((point) => ({
    ...point,
    label: new Date(`${point.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }));

  return (
    <section className="space-y-3" aria-label="BotTrader Analytics">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]"><Bot className="h-5 w-5 text-[var(--status-positive)]" /> BotTrader Analytics</h2>
        <button onClick={() => void load(false)} disabled={refreshing} className="min-h-11 min-w-11 rounded-lg border border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50" aria-label="Refresh BotTrader analytics"><RefreshCw className={`mx-auto h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /></button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-[var(--status-negative)]/40 bg-[var(--status-negative)]/10 px-3 py-2 text-xs text-[var(--status-negative)]">{error}</div>}

      <div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1" role="tablist" aria-label="BotTrader views">
        {(['analytics', 'logs', 'messages'] as const).map((tab) => <button key={tab} role="tab" aria-selected={view === tab} onClick={() => setView(tab)} className={`min-h-11 rounded-md px-4 text-xs font-semibold capitalize ${view === tab ? 'bg-[var(--status-positive)] text-black' : 'text-[var(--text-secondary)]'}`}>{tab}</button>)}
      </div>

      {status?.workflow && <div className={`rounded-lg border px-3 py-2 ${status.workflow.health === 'healthy' ? 'border-[var(--status-positive)]/40 bg-[var(--status-positive)]/10' : 'border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-[var(--text-primary)]">
          <span>Execution workflow: {status.workflow.health}</span>
          <span>{status.workflow.requestedExecutionMode} requested · {status.workflow.effectiveExecutionMode} effective</span>
        </div>
        <div className="mt-1 text-[10px] text-[var(--text-secondary)]">Latest completed scan {status.workflow.latestCompletedScanId ?? 'none'} · cursor {status.workflow.cursorScanId} · lag {status.workflow.cursorLag} · {status.workflow.opportunitiesEvaluated} opportunities evaluated · {status.workflow.eligibleCount} eligible</div>
        {status.workflow.degradedReasons.length > 0 && <div className="mt-1 text-[10px] text-[var(--status-warning)]">{status.workflow.degradedReasons.join(' · ')}</div>}
        {status.workflow.lastExecutionOrSkip && <div className="mt-1 text-[10px] text-[var(--text-secondary)]">Last result: scan {status.workflow.lastExecutionOrSkip.scanId} — {status.workflow.lastExecutionOrSkip.state}: {status.workflow.lastExecutionOrSkip.reason}</div>}
      </div>}

      {status && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2">
        <div><div className="text-xs font-semibold text-[var(--text-primary)]">Ranked candidate sources</div><div className="text-[10px] text-[var(--text-secondary)]">All ROI and profit values are net of trading fees. This does not enable live trading.</div></div>
        <div className="flex items-center gap-2" role="group" aria-label="BotTrader ranked candidate sources">
          <label title="ROI ranks eligible markets by highest fee-net return on invested capital." className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-semibold ${status.selectionMethod !== 'apy' ? 'border-[var(--status-positive)] bg-[var(--status-positive)]/10 text-[var(--status-positive)]' : 'border-[var(--border-strong)] text-[var(--text-secondary)]'}`}><input type="checkbox" checked={status.selectionMethod !== 'apy'} disabled={saving} onChange={(event) => setRankSource('roi', event.target.checked)} /> ROI</label>
          <label title="APY ranks eligible markets by annualized yield while still requiring positive fee-net ROI." className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-semibold ${status.selectionMethod !== 'roi' ? 'border-[var(--status-positive)] bg-[var(--status-positive)]/10 text-[var(--status-positive)]' : 'border-[var(--border-strong)] text-[var(--text-secondary)]'}`}><input type="checkbox" checked={status.selectionMethod !== 'roi'} disabled={saving} onChange={(event) => setRankSource('apy', event.target.checked)} /> APY</label>
          <span title="Hybrid requires both configured ROI and APY thresholds and ranks deterministically by ROI, then APY." className="rounded-md bg-[var(--surface-workspace)] px-2 py-1 text-[10px] font-bold uppercase text-[var(--text-primary)]">{status.selectionMethod}</span>
        </div>
      </div>}

      {view === 'logs' ? <BotActionLogs selectionMethod={status?.selectionMethod} /> : view === 'messages' ? <BotTraderMessages /> : <div className="space-y-3">

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-[var(--text-secondary)]">Mode <select aria-label="Filter position mode" value={modeFilter} onChange={(event) => changePerformanceFilter(modeFilter, event.target.value as PositionModeFilter, setModeFilter)} className="ml-1 min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="paper">Paper</option><option value="production">Live</option></select></label>
          <label className="text-xs text-[var(--text-secondary)]">Method <select aria-label="Performance method" value={methodFilter} onChange={(event) => changePerformanceFilter(methodFilter, event.target.value as PerformanceMethod, setMethodFilter)} className="ml-1 min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="all">All Bot methods</option><option value="roi">ROI</option><option value="apy">APY</option><option value="hybrid">Hybrid</option><option value="legacy">Legacy / unknown</option></select></label>
        </div>
        <div className="flex flex-wrap rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] p-0.5" aria-label="Performance date range">
          {RANGE_OPTIONS.map((option) => <button key={option.key} aria-label={option.label} disabled={range === option.key} onClick={() => changePerformanceFilter(range, option.key, setRange)} className={`min-h-11 rounded-md px-2.5 text-[10px] font-semibold disabled:cursor-default ${range === option.key ? 'bg-[var(--status-positive)]/20 text-[var(--status-positive)]' : 'text-[var(--text-secondary)]'}`}>{option.label}</button>)}
        </div>
        <div className="w-full text-[10px] text-[var(--text-secondary)]">{range === 'today' ? 'Today uses the server-local calendar boundary.' : range === 'all' ? 'All verified BotTrader executions.' : `${rangeLabel} uses the same rolling boundary as Dashboard.`} All amounts include entry and executable exit fees.</div>
      </div>

      {status && (
        <div className={`rounded-lg border px-3 py-3 ${status.enabled ? (status.botStatus === 'Blocked' ? 'border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10' : 'border-[var(--status-positive)]/40 bg-[var(--status-positive)]/10') : 'border-[var(--border-subtle)] bg-[var(--surface-panel)]'}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Bot className={`h-4 w-4 ${status.enabled ? (status.botStatus === 'Blocked' ? 'text-[var(--status-warning)]' : 'text-[var(--status-positive)]') : 'text-[var(--text-secondary)]'}`} />
              <span className="font-semibold">BotTrader: {status.botStatus ?? (status.enabled ? 'ON' : 'OFF')}</span>
              <span className="text-[var(--text-secondary)]">· {status.mode === 'production' ? 'Production' : 'Paper'} mode · {status.selectionMethod.toUpperCase()} selection · {INTEGER.format(status.todayCount)} trades today · {formatUsd(status.todayStakeUsd)} staked</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={toggleEnabled} disabled={saving} className={`min-h-11 rounded-lg px-3 text-xs font-semibold transition-colors disabled:opacity-50 ${status.enabled ? 'border border-[var(--status-negative)]/40 text-[var(--status-negative)]' : 'bg-[var(--status-positive)] text-black'}`}>{status.enabled ? 'Disable Bot' : 'Enable Bot'}</button>
              <button onClick={toggleMode} disabled={saving} className={`min-h-11 rounded-lg border px-3 text-xs font-semibold disabled:opacity-50 ${status.mode === 'production' ? 'border-[var(--status-warning)]/50 text-[var(--status-warning)]' : 'border-[var(--border-strong)] text-[var(--text-primary)]'}`}>{status.mode === 'production' ? 'Switch to Paper' : 'Switch to Production'}</button>
            </div>
          </div>
          {status.paperBlockedReasons && status.paperBlockedReasons.length > 0 && (
            <div className="mt-1 text-[10px] text-[var(--status-warning)]">
              {status.paperBlockedReasons.join(' · ')}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricCard label="Verified trades" value={INTEGER.format(analytics.totalBotTrades.total)} />
        <MetricCard label="Open positions" value={INTEGER.format(analytics.openPositions.count)} />
        <MetricCard label="Settled positions" value={INTEGER.format(analytics.settledPositions.count)} />
        <MetricCard label="Win rate" value={formatBps(analytics.settledPositions.winRateBps)} />
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div title="Cumulative fee-inclusive cost of open exposure"><MetricCard label="Deployed" value={performance.capital.deployedCents == null ? 'Unavailable' : formatCents(performance.capital.deployedCents)} valueClass={performance.capital.deployedCents == null ? 'text-[var(--status-warning)]' : ''} /></div>
        <MetricCard label="Indicative value" value={formatCents(performance.capital.currentCents)} valueClass={performance.capital.excludedOpenCostCents > 0 ? 'text-[var(--status-warning)]' : ''} />
        <MetricCard label="Held to resolution" value={formatCents(performance.capital.heldToResolutionCents)} />
        <div title="Unrealized return on remaining open cost"><MetricCard label="Portfolio ROI" value={performance.pnl.roiBps == null ? 'Unavailable' : formatBps(performance.pnl.roiBps, true)} valueClass={performance.pnl.roiBps == null ? 'text-[var(--status-warning)]' : pnlClass(performance.pnl.roiBps)} /></div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <MetricCard label="Unrealized" value={performance.pnl.unrealizedCents == null ? 'Unavailable' : formatCents(performance.pnl.unrealizedCents, true)} valueClass={performance.pnl.unrealizedCents == null ? 'text-[var(--status-warning)]' : pnlClass(performance.pnl.unrealizedCents)} />
        <MetricCard label="Realized" value={formatCents(performance.pnl.realizedCents, true)} valueClass={pnlClass(performance.pnl.realizedCents)} />
        <MetricCard label="Total P&L" value={performance.pnl.totalCents == null ? 'Unavailable' : formatCents(performance.pnl.totalCents, true)} valueClass={performance.pnl.totalCents == null ? 'text-[var(--status-warning)]' : pnlClass(performance.pnl.totalCents)} />
      </div>

      <div className={`rounded-lg border px-3 py-2 text-xs ${quoteIssueCount > 0 ? 'border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]' : 'border-[var(--status-positive)]/30 bg-[var(--status-positive)]/10 text-[var(--text-secondary)]'}`}>
        {quoteIssueCount > 0
          ? `${performance.valuation.stale} stale indicative mark${performance.valuation.stale === 1 ? '' : 's'} · ${performance.valuation.unavailable} unavailable · ${performance.valuation.pendingSettlement} pending settlement verification. Stale last-scanned marks remain included; ${formatCents(performance.capital.excludedOpenCostCents)} of unavailable open buy cost is excluded, never treated as zero.`
          : `Indicative marks fresh for ${performance.valuation.fresh} open position${performance.valuation.fresh === 1 ? '' : 's'}${performance.valuation.asOf ? ` · oldest last-scanned mark ${new Date(performance.valuation.asOf).toLocaleString()}` : ''}.`}
      </div>

      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3">
        <div className="mb-2 flex items-center justify-between"><div><div className="text-sm font-semibold">Current performance by entry date</div><div className="text-[10px] text-[var(--text-secondary)]">Cohorts use each position&apos;s latest authoritative value; this is not historical portfolio performance.</div></div><div className="text-[10px] text-[var(--text-secondary)]">{rangeLabel} · verified {modeFilter === 'paper' ? 'paper' : 'live'} executions</div></div>
        {chartData.length === 0 ? <div className="py-10 text-center text-sm text-[var(--text-secondary)]">No verified BotTrader executions in this range.</div> : <div role="img" aria-label="BotTrader current performance by entry date chart" className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} tickFormatter={(value: number) => formatCents(value)} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="deployedCents" name="Deployed" fill="var(--text-secondary)" />
              <Bar dataKey="currentCents" name="Indicative value" fill="var(--status-info)" />
              <Bar dataKey="heldToResolutionCents" name="Held to resolution" fill="var(--platform-polymarket)" />
              <Bar dataKey="realizedCents" name="Realized P&L" fill="var(--status-positive)" />
              <Bar dataKey="unrealizedCents" name="Unrealized P&L" fill="var(--status-warning)" />
            </BarChart>
          </ResponsiveContainer>
        </div>}
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <div><div className="text-sm font-semibold text-[var(--text-primary)]">Positions</div><div className="text-[10px] text-[var(--text-secondary)]">Persisted exact-leg last-scanned marks · indicative only, not executable close proceeds</div></div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] p-0.5" aria-label="Position status filter">
              {(['all', 'open', 'settled'] as const).map((value) => <button key={value} onClick={() => setFilter(value)} className={`min-h-11 rounded-md px-3 text-xs capitalize ${filter === value ? 'bg-[var(--status-positive)] text-black' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{value}</button>)}
            </div>
            <label className="text-xs text-[var(--text-secondary)]">Sort <select aria-label="Sort positions" value={sortKey} onChange={(event) => changeSort(event.target.value as SortKey)} className="ml-1 min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="openedAt">Opened</option><option value="pnl">P&amp;L</option><option value="roi">ROI</option></select></label>
            <button onClick={() => setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')} className="min-h-11 rounded-lg border border-[var(--border-strong)] px-2 text-xs text-[var(--text-secondary)]" aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}>{sortDirection === 'asc' ? '↑ Asc' : '↓ Desc'}</button>
            <a href={`/api/bot-trader/positions/export?method=${methodFilter}&mode=${modeFilter}&range=${range}`} className="inline-flex min-h-11 items-center rounded-lg border border-[var(--border-strong)] px-3 text-xs text-[var(--text-secondary)]">Export exact legs CSV</a>
          </div>
        </div>

        <div className="overflow-x-auto" data-testid="bot-positions-scroll">
          <span id="entry-arb-profit-header-description" className="sr-only">{ENTRY_ARB_PROFIT_DESCRIPTION}</span>
          {sortedPositions.map((position) => {
            const presentation = entryArbProfitPresentation(position.entryArbProfitSnapshot);
            const classification = exposureClassification(position, presentation);
            return <span key={`position-description-${position.id}`}>
              <span id={`entry-arb-profit-description-${position.id}`} className="sr-only">{presentation.available ? presentation.title : 'Unavailable; expand position details for the exact reason and provenance'}</span>
              <span id={`exposure-classification-description-${position.id}`} className="sr-only">{classification.detail}</span>
            </span>;
          })}
          <table className="w-full min-w-[960px] text-xs">
            <thead><tr className="border-b border-[var(--border-subtle)] text-[10px] uppercase tracking-wide text-[var(--text-secondary)]"><th title="Expand position details" className="w-8 px-2 py-2" /><th title="Market event name" className="px-2 py-2 text-left font-medium">Market</th><th title="Immutable selection method captured when BotTrader chose this trade" className="px-2 py-2 text-center font-medium">Method</th><th title="Exact contract sides bought on each platform" className="px-2 py-2 text-left font-medium">Strategy</th><th title="Immutable persisted trade entry cost" className="px-2 py-2 text-right font-medium">Buy Cost</th><th title="Indicative value from exact-leg last-scanned prices; not executable liquidation proceeds" className="px-2 py-2 text-right font-medium">Current Value</th><th title="Indicative last-scanned Current Value minus persisted Buy Cost" className="px-2 py-2 text-right font-medium">P&amp;L</th><th title="Indicative last-scanned P&L divided by persisted Buy Cost" className="px-2 py-2 text-right font-medium">ROI</th><th tabIndex={0} title={ENTRY_ARB_PROFIT_DESCRIPTION} aria-describedby="entry-arb-profit-header-description" className="hidden rounded px-2 py-2 text-right font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-info)] lg:table-cell">Entry Arb Profit</th><th title="Position state: open, settled, or closed" className="px-2 py-2 text-center font-medium">Status</th><th title="When the bot placed this trade" className="px-2 py-2 text-right font-medium">Opened</th></tr></thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {sortedPositions.map((position) => {
                const isExpanded = expanded.has(position.id);
                const hasCanonicalOutcomes = position.outcomeIdentityStatus === 'verified'
                  && Boolean(position.kalshiOutcomeLabel?.trim())
                  && Boolean(position.pmOutcomeLabel?.trim());
                const entryArbProfit = entryArbProfitPresentation(position.entryArbProfitSnapshot);
                const classification = exposureClassification(position, entryArbProfit);
                const entryCostAvailable = position.entryCostStatus !== 'unavailable'
                  && Number.isSafeInteger(position.totalCostCents);
                const unallocatedEntryFeeCents = position.unallocatedEntryFeeCents ?? 0;
                const feeSplitAvailable = unallocatedEntryFeeCents === 0;
                const entryCostUnavailableLabel = entryCostAvailable
                  ? null
                  : `Buy Cost unavailable: ${position.entryCostFailureReason || 'Authoritative entry fill or fee evidence is incomplete'}`;
                const openMark = position.status === 'open' ? openPositionMark(position) : null;
                const pnl = position.status === 'open'
                  ? (openMark?.available && entryCostAvailable ? openMark.pnlCents : null)
                  : entryCostAvailable ? position.realizedPnlCents : null;
                const roiBps = position.status === 'open'
                  ? (openMark?.available && entryCostAvailable ? openMark.roiBps : null)
                  : entryCostAvailable && hasVerifiedTerminalAccounting(position) ? positionRoiBps(position) : null;
                const openUnavailableLabel = openMark && !openMark.available ? openMark.label : null;
                const staleValuationLabel = openMark?.available && !openMark.fresh ? openMark.warning : null;
                const staleValuationProvenance = staleValuationLabel?.toLowerCase().includes('legacy last-known')
                  ? 'Legacy last-known'
                  : 'Stale';
                const settlementUnavailableLabel = position.status !== 'open' && !hasVerifiedTerminalAccounting(position) ? 'Pending verification' : null;
                const valueUnavailableLabel = openUnavailableLabel ?? settlementUnavailableLabel;
                const kalshiHeld = Number.isSafeInteger(position.remainingSharesKalshi)
                  ? position.remainingSharesKalshi!
                  : position.sharesKalshi;
                const pmHeld = Number.isSafeInteger(position.remainingSharesPm)
                  ? position.remainingSharesPm!
                  : position.sharesPm;
                const hasLiquidationBreakdown = valueUnavailableLabel == null
                  && position.currentValueCents != null
                  && Number.isSafeInteger(position.kalshiGrossProceedsMicrocents)
                  && Number.isSafeInteger(position.pmGrossProceedsMicrocents)
                  && Number.isSafeInteger(position.kalshiNetProceedsCents)
                  && Number.isSafeInteger(position.pmNetProceedsCents)
                  && Number.isSafeInteger(position.kalshiExitFeeCents)
                  && Number.isSafeInteger(position.pmExitFeeCents)
                  && kalshiHeld > 0
                  && pmHeld > 0
                  && position.kalshiExitFeeType === 'quadratic'
                  && Number.isSafeInteger(position.kalshiExitFeeMultiplierPpm)
                  && Number.isSafeInteger(position.pmExitFeeRateBps)
                  && position.kalshiNetProceedsCents! + position.pmNetProceedsCents! === position.currentValueCents;
                const liquidationUnavailableLabel = position.status !== 'open'
                  ? 'Not applicable after resolution'
                  : valueUnavailableLabel ?? (hasLiquidationBreakdown ? null : 'Valuation unavailable: incomplete executable liquidation evidence');
                const kalshiNetProceedsCents = hasLiquidationBreakdown
                  ? position.kalshiNetProceedsCents!
                  : null;
                const pmNetProceedsCents = hasLiquidationBreakdown
                  ? position.pmNetProceedsCents!
                  : null;
                const kalshiSnapshot = position.currentPriceSnapshots?.kalshi ?? {
                  status: 'never_saved' as const, priceCents: null, source: null, observedAt: null, ageMs: null,
                };
                const polymarketSnapshot = position.currentPriceSnapshots?.polymarket ?? {
                  status: 'never_saved' as const, priceCents: null, source: null, observedAt: null, ageMs: null,
                };
                const primaryWarnings = Array.from(new Set([
                  position.settlementFailureReason ? 'Settlement needs review' : null,
                  position.outcomeIdentityFailureReason || classification.label === 'Legacy identity missing' ? 'Outcome identity missing' : null,
                  !entryCostAvailable ? 'Buy Cost unavailable' : null,
                  valueUnavailableLabel ? 'Current value unavailable' : null,
                  staleValuationLabel ? 'Current prices stale' : null,
                  classification.isExposureOnly ? 'Excluded from verified analytics' : null,
                ].filter((warning): warning is string => Boolean(warning))));
                return [
                  <tr key={`row-${position.id}`} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(position.id)) next.delete(position.id); else next.add(position.id); return next; })} className="cursor-pointer hover:bg-[var(--border-subtle)]/50" aria-expanded={isExpanded}>
                    <td className="px-2 py-2 text-[var(--text-secondary)]"><button type="button" onClick={(event) => { event.stopPropagation(); setExpanded((current) => { const next = new Set(current); if (next.has(position.id)) next.delete(position.id); else next.add(position.id); return next; }); }} className="flex min-h-11 min-w-11 items-center justify-center rounded outline-none hover:bg-[var(--border-strong)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--status-info)]" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${position.marketTitle}`} aria-describedby={`exposure-classification-description-${position.id}`}>{isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button></td>
                    <td className="max-w-56 px-2 py-2 font-medium text-[var(--text-primary)]" title={position.marketTitle}>{position.marketId ? <a href={`/?view=scan&id=${encodeURIComponent(position.marketId)}`} aria-label={`Open ${position.marketTitle} market`} onClick={(event) => event.stopPropagation()} className="block truncate underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--status-positive)]">{position.marketTitle}</a> : <span className="block truncate">{position.marketTitle}</span>}<div className="mt-1 flex gap-2 text-[9px] font-normal">{position.kalshiUrl && <a href={position.kalshiUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open exact Kalshi ${position.kalshiSide.toUpperCase()} market for ${position.marketTitle}`} onClick={(event) => event.stopPropagation()} className="text-[var(--status-positive)] underline">Kalshi {position.kalshiSide.toUpperCase()}</a>}{position.polymarketUrl && <a href={position.polymarketUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open exact Polymarket ${position.pmSide.toUpperCase()} market for ${position.marketTitle}`} onClick={(event) => event.stopPropagation()} className="text-[var(--status-info)] underline">PM {position.pmSide.toUpperCase()}</a>}{!position.kalshiUrl && !position.polymarketUrl && <span className="text-[var(--text-muted)]">Link unavailable</span>}<span className="text-[var(--text-muted)]">#{position.executionId}</span></div><div data-testid="responsive-entry-arb-profit" tabIndex={0} aria-label={entryArbProfit.available ? `Entry Arb Profit ${entryArbProfit.label} USDC` : 'Entry Arb Profit unavailable'} aria-describedby={`entry-arb-profit-description-${position.id}`} className={`mt-1 rounded text-[9px] font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-info)] lg:hidden ${entryArbProfit.available ? pnlClass(entryArbProfit.value) : 'text-[var(--status-warning)]'}`} title={entryArbProfit.available ? entryArbProfit.title : undefined}>Entry arb {entryArbProfit.label}</div><ExposureBadge classification={classification} testId="responsive-exposure-classification" className="mt-1 lg:hidden" /></td>
                    <td className="px-2 py-2 text-center"><span className={`rounded bg-[var(--border-strong)] px-1.5 py-0.5 text-[9px] font-bold uppercase ${position.selectionMethod ? 'text-[var(--text-primary)]' : 'text-[var(--status-warning)]'}`}>{position.selectionMethod?.toUpperCase() ?? 'Legacy/Unknown'}</span></td>
                    <td className="max-w-52 px-2 py-2 text-[var(--text-primary)]">
                      <div>Kalshi {position.kalshiSide.toUpperCase()}</div><div>PM {position.pmSide.toUpperCase()}</div>
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums ${entryCostAvailable ? 'text-[var(--text-primary)]' : 'text-[var(--status-warning)]'}`}>{entryCostAvailable ? formatCents(position.totalCostCents) : 'Unavailable'}</td>
                    <td data-valuation-kind={classification.isExposureOnly ? 'exposure-mark' : 'verified-arbitrage'} className={`px-2 py-2 text-right tabular-nums ${valueUnavailableLabel || staleValuationLabel ? 'text-[var(--status-warning)]' : 'text-[var(--text-primary)]'}`} title={staleValuationLabel ?? undefined}>{valueUnavailableLabel ? 'Unavailable' : (position.status === 'open' && openMark?.available ? `${formatCents(openMark.currentValueCents)}${staleValuationLabel ? ` · ${staleValuationProvenance}` : ''}` : formatCents(position.resolutionPayoutCents!))}</td>
                    <td data-valuation-kind={classification.isExposureOnly ? 'exposure-mark' : 'verified-arbitrage'} className={`px-2 py-2 text-right font-semibold tabular-nums ${pnl == null ? 'text-[var(--status-warning)]' : pnlClass(pnl)}`} title={staleValuationLabel ?? 'Indicative last-scanned mark-to-market P&L'}>{valueUnavailableLabel || entryCostUnavailableLabel || pnl == null ? 'Unavailable' : formatCents(pnl, true)}</td>
                    <td data-valuation-kind={classification.isExposureOnly ? 'exposure-mark' : 'verified-arbitrage'} className={`px-2 py-2 text-right tabular-nums ${roiBps == null || valueUnavailableLabel ? 'text-[var(--status-warning)]' : pnlClass(roiBps)}`} title={staleValuationLabel ?? 'Indicative last-scanned mark-to-market ROI'}>{valueUnavailableLabel || entryCostUnavailableLabel || roiBps == null ? 'Unavailable' : formatBps(roiBps, true)}</td>
                    <td tabIndex={0} className={`hidden whitespace-nowrap rounded px-2 py-2 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--status-info)] lg:table-cell ${entryArbProfit.available ? pnlClass(entryArbProfit.value) : 'text-[var(--status-warning)]'}`} title={entryArbProfit.available ? entryArbProfit.title : undefined} aria-label={entryArbProfit.available ? `Entry Arb Profit ${entryArbProfit.label} USDC` : 'Entry Arb Profit unavailable'} aria-describedby={`entry-arb-profit-description-${position.id}`}>{entryArbProfit.label}</td>
                    <td className="px-2 py-2 text-center"><div className="flex flex-col items-center gap-1"><StatusBadge position={position} /><ExposureBadge classification={classification} testId="desktop-exposure-classification" className="hidden lg:inline-flex" /></div></td>
                    <td className="px-2 py-2 text-right text-[var(--text-secondary)]" title={new Date(position.openedAt).toLocaleString()}>{timeAgo(position.openedAt)}</td>
                  </tr>,
                  isExpanded && <tr key={`detail-${position.id}`}>
                    <td colSpan={11} className="bg-[var(--surface-workspace)] px-2 py-3 sm:px-6">
                      <div data-testid="position-detail-layout" className="sticky left-0 min-w-0 w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3 sm:p-4 lg:w-auto lg:max-w-none">
                        <div data-testid="exposure-classification-detail">
                          <div className={`flex min-w-0 flex-wrap items-start justify-between gap-2 rounded border px-3 py-2 text-xs ${classification.style}`}>
                            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2"><strong>Position status</strong><StatusBadge position={position} /><ExposureBadge classification={classification} testId="expanded-exposure-classification" />{primaryWarnings.map((warning) => <span key={warning} className="font-medium text-[var(--text-primary)]">{warning}</span>)}</div>
                          </div>

                          <div data-testid="position-decision-summary" className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded border border-[var(--border-subtle)] bg-[var(--border-subtle)] sm:grid-cols-3 lg:grid-cols-5">
                            <div className="min-w-0 bg-[var(--surface-workspace)] px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">Buy Cost</div><div className={`mt-0.5 truncate font-semibold tabular-nums ${entryCostAvailable ? 'text-[var(--text-primary)]' : 'text-[var(--status-warning)]'}`}>{entryCostAvailable ? formatCents(position.totalCostCents) : 'Unavailable'}</div></div>
                            <div className="min-w-0 bg-[var(--surface-workspace)] px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">Current Value</div><div className={`mt-0.5 truncate font-semibold tabular-nums ${valueUnavailableLabel || staleValuationLabel ? 'text-[var(--status-warning)]' : 'text-[var(--text-primary)]'}`}>{valueUnavailableLabel ? 'Unavailable' : position.status === 'open' && openMark?.available ? formatCents(openMark.currentValueCents) : formatCents(position.resolutionPayoutCents!)}</div></div>
                            <div className="min-w-0 bg-[var(--surface-workspace)] px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">P&amp;L</div><div className={`mt-0.5 truncate font-semibold tabular-nums ${pnl == null ? 'text-[var(--status-warning)]' : pnlClass(pnl)}`}>{valueUnavailableLabel || entryCostUnavailableLabel || pnl == null ? 'Unavailable' : formatCents(pnl, true)}</div></div>
                            <div className="min-w-0 bg-[var(--surface-workspace)] px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">ROI</div><div className={`mt-0.5 truncate font-semibold tabular-nums ${roiBps == null ? 'text-[var(--status-warning)]' : pnlClass(roiBps)}`}>{valueUnavailableLabel || entryCostUnavailableLabel || roiBps == null ? 'Unavailable' : formatBps(roiBps, true)}</div></div>
                            <div className="col-span-2 min-w-0 bg-[var(--surface-workspace)] px-3 py-2 sm:col-span-1"><div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">Entry Arb Profit</div><div className={`mt-0.5 truncate font-semibold tabular-nums ${entryArbProfit.available ? pnlClass(entryArbProfit.value) : 'text-[var(--status-warning)]'}`}>{entryArbProfit.label}</div><div className="truncate text-[9px] text-[var(--text-muted)]">Immutable at placement</div></div>
                          </div>

                          <div className="mt-3 flex items-center justify-between gap-3"><h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Placed trade</h3><span className="text-[10px] text-[var(--text-muted)]">Expires {position.expiryDate ? new Date(position.expiryDate).toLocaleDateString() : '—'}</span></div>
                          {!entryCostAvailable ? <div className="mt-2 rounded border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-3 py-2 text-xs font-semibold text-[var(--status-warning)]">Buy Cost unavailable: {position.entryCostFailureReason || 'Recorded Buy Cost is missing or invalid'}</div> : null}
                          <div role="group" aria-label="Placed trade legs" className="mt-2 grid min-w-0 gap-2 lg:grid-cols-2">
                            {([
                              { venue: 'Kalshi', outcome: position.kalshiOutcomeLabel, side: position.kalshiSide, shares: position.sharesKalshi, gross: position.kalshiEntryGrossMicrocents, fee: position.kalshiEntryFeeCents ?? 0, snapshot: kalshiSnapshot, testId: 'kalshi-entry-cost', priceTestId: 'kalshi-stored-current-price' },
                              { venue: 'Polymarket', outcome: position.pmOutcomeLabel, side: position.pmSide, shares: position.sharesPm, gross: position.pmEntryGrossMicrocents, fee: position.pmEntryFeeCents ?? 0, snapshot: polymarketSnapshot, testId: 'polymarket-entry-cost', priceTestId: 'polymarket-stored-current-price' },
                            ] as const).map((leg) => <div key={leg.venue} data-testid={leg.testId} className="min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--surface-workspace)] px-3 py-2 text-xs">
                              <div className={`min-w-0 truncate font-semibold ${hasCanonicalOutcomes ? 'text-[var(--text-primary)]' : 'text-[var(--status-warning)]'}`}>{leg.venue} {hasCanonicalOutcomes ? `${leg.outcome!.trim()} — ` : ''}{leg.side.toUpperCase()} entry</div>
                              {entryCostAvailable && leg.gross != null ? <><div className="mt-2 tabular-nums text-[var(--text-secondary)]">{INTEGER.format(leg.shares)} unit{leg.shares === 1 ? '' : 's'} · {formatExactEntryPrice(leg.gross, leg.shares)} {entryPricePrecisionLabel(leg.gross, leg.shares)} · {formatMicrocents(leg.gross)} gross</div><div className="tabular-nums text-[var(--text-secondary)]">{feeSplitAvailable ? <>{formatExactMicrocents(leg.fee * 1_000_000)} execution fee · <strong className="text-[var(--text-primary)]">{formatExactMicrocents(leg.gross + leg.fee * 1_000_000)} net leg cost</strong></> : <>Platform fee allocation unavailable for this legacy entry</>}</div><dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-[var(--border-subtle)] pt-2 tabular-nums"><dt className="text-[var(--text-secondary)]">Quantity</dt><dd>{INTEGER.format(leg.shares)} unit{leg.shares === 1 ? '' : 's'}</dd><dt className="text-[var(--text-secondary)]">Entry price</dt><dd>{formatExactEntryPrice(leg.gross, leg.shares)}</dd><dt className="text-[var(--text-secondary)]">Entry fee</dt><dd>{feeSplitAvailable ? formatExactMicrocents(leg.fee * 1_000_000) : 'Unavailable'}</dd><dt className="text-[var(--text-secondary)]">Leg cost</dt><dd>{formatExactMicrocents(leg.gross + (feeSplitAvailable ? leg.fee * 1_000_000 : 0))}</dd></dl></> : <div className="mt-2 text-[var(--status-warning)]">Entry price and cost unavailable</div>}
                              <div data-testid={leg.priceTestId} className="mt-2 flex min-w-0 items-end justify-between gap-3 border-t border-[var(--border-subtle)] pt-2"><div className="min-w-0"><div className="truncate font-semibold text-[var(--text-primary)]">{leg.venue} {hasCanonicalOutcomes ? `${leg.outcome!.trim()} — ` : ''}{leg.side.toUpperCase()} Current Price</div><div className="text-[9px] text-[var(--text-secondary)]">Persisted last scan</div></div><div className="text-right"><div className={leg.snapshot.status === 'available' ? 'text-[var(--text-primary)]' : 'text-[var(--status-warning)]'}>{snapshotStateLabel(leg.snapshot)}</div><div className="font-semibold tabular-nums">{leg.snapshot.priceCents == null ? 'Unavailable' : formatCents(leg.snapshot.priceCents)}</div></div></div>
                            </div>)}
                          </div>
                          <div className="mt-2 text-[10px] text-[var(--text-secondary)]">Current prices are persisted indicative last-scanned marks; not executable liquidation proceeds.</div>
                        </div>

                      {position.settlementState && position.settlementState !== 'open' && <div data-testid="position-settlement-summary" className="mt-3 rounded border border-[var(--border-strong)] bg-[var(--surface-panel)] px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><strong className="text-[var(--text-primary)]">Settlement</strong><StatusBadge position={position} /></div><span className="text-[var(--text-secondary)]">{position.dryRun ? 'Paper' : 'Live'}</span></div>
                        {position.settlementFailureReason && <div className="mt-2 font-semibold text-[var(--status-warning)]">{position.settlementFailureReason}</div>}
                        <div className="mt-2 grid gap-2 lg:grid-cols-2">
                          {(position.settlementLegs ?? []).map((leg) => <div key={leg.venue} data-testid={`${leg.venue}-settlement-leg`} className="rounded border border-[var(--border-subtle)] px-2 py-2">
                            <div className="font-semibold capitalize text-[var(--text-primary)]">{leg.venue} {leg.side.toUpperCase()}</div>
                            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 tabular-nums"><dt className="text-[var(--text-secondary)]">Quantity</dt><dd>{leg.filledQuantity == null ? 'Unknown' : `${INTEGER.format(leg.filledQuantity)} filled`}</dd><dt className="text-[var(--text-secondary)]">Payout</dt><dd>{leg.payoutEntitlementCents == null ? 'Unavailable' : formatCents(leg.payoutEntitlementCents)}</dd><dt className="text-[var(--text-secondary)]">Fee</dt><dd>{leg.settlementFeeCents == null ? 'Unavailable' : formatCents(leg.settlementFeeCents)}</dd><dt className="text-[var(--text-secondary)]">Net proceeds</dt><dd>{leg.netSettlementProceedsCents == null ? 'Pending' : formatCents(leg.netSettlementProceedsCents)}</dd></dl>
                            {leg.failureReason && <div className="mt-1 text-[var(--status-warning)]">{leg.failureReason}</div>}
                          </div>)}
                        </div>
                        <div className="mt-2 flex flex-wrap justify-between gap-2 border-t border-[var(--border-subtle)] pt-2"><span>Net settlement proceeds</span><strong>{position.settlementNetProceedsCents == null ? 'Pending reconciliation' : formatCents(position.settlementNetProceedsCents)}</strong></div>
                      </div>}
                      {liquidationUnavailableLabel ? (
                        <div className="mt-3 rounded border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-3 py-2 text-xs font-semibold text-[var(--status-warning)]">Liquidation breakdown: {liquidationUnavailableLabel}</div>
                      ) : (
                        <div className="mt-3 grid gap-2 text-xs lg:grid-cols-2">
                          <div data-testid="kalshi-liquidation" className="rounded border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2">
                            <div className="font-semibold text-[var(--text-primary)]">Kalshi {position.kalshiSide.toUpperCase()}</div>
                            <div className="mt-1 tabular-nums text-[var(--text-secondary)]">{INTEGER.format(kalshiHeld)} held · {formatVwapCents(position.kalshiGrossProceedsMicrocents!, kalshiHeld)} VWAP · {formatMicrocents(position.kalshiGrossProceedsMicrocents!)} gross</div>
                            <div className="tabular-nums text-[var(--text-secondary)]">{formatCents(position.kalshiExitFeeCents!)} fee ({position.kalshiExitFeeType}, ×{(position.kalshiExitFeeMultiplierPpm! / 1_000_000).toFixed(6)}) · <strong className="text-[var(--text-primary)]">{formatCents(kalshiNetProceedsCents!)} net</strong></div>
                          </div>
                          <div data-testid="polymarket-liquidation" className="rounded border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2">
                            <div className="font-semibold text-[var(--text-primary)]">Polymarket {position.pmSide.toUpperCase()}</div>
                            <div className="mt-1 tabular-nums text-[var(--text-secondary)]">{INTEGER.format(pmHeld)} held · {formatVwapCents(position.pmGrossProceedsMicrocents!, pmHeld)} VWAP · {formatMicrocents(position.pmGrossProceedsMicrocents!)} gross</div>
                            <div className="tabular-nums text-[var(--text-secondary)]">{formatCents(position.pmExitFeeCents!)} fee ({(position.pmExitFeeRateBps! / 100).toFixed(2)}%) · <strong className="text-[var(--text-primary)]">{formatCents(pmNetProceedsCents!)} net</strong></div>
                          </div>
                          <div data-testid="combined-net-proceeds" className="flex items-center justify-between rounded border border-[var(--border-strong)] px-3 py-2 font-semibold lg:col-span-2"><span>Combined net proceeds</span><span className="tabular-nums">{formatCents(kalshiNetProceedsCents! + pmNetProceedsCents!)}</span></div>
                        </div>
                      )}
                      <details data-testid="position-technical-details" className="mt-3 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--surface-workspace)] text-xs">
                        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-semibold text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--status-warning)]"><span>Technical details</span><span className="text-[10px] font-normal text-[var(--text-secondary)]">Evidence, identifiers, fills &amp; authorities</span></summary>
                        <div className="min-w-0 space-y-3 border-t border-[var(--border-subtle)] px-3 py-3 text-[10px] text-[var(--text-secondary)]">
                          <section><strong className="text-[var(--text-primary)]">Classification evidence</strong>{classification.reasons.map((reason) => <div key={reason} className="break-words text-[var(--status-warning)]">{reason}</div>)}{classification.evidence.length ? classification.evidence.map((item) => <div key={`${item.source}-${item.revision}`} className="break-words font-mono">{item.source} · {item.confidence.replaceAll('_', ' ')} · captured {item.capturedAt} · revision {item.revision}</div>) : <div>Evidence provenance unavailable</div>}<div>{classification.missingIdentifiers.length ? classification.missingIdentifiers.join(' · ') : 'Exact held identifiers recorded'} · {classification.excludedFromVerifiedTotals ? 'Excluded from verified-arbitrage totals' : 'Included in verified-arbitrage totals'}</div><div>Exposure marks never authorize trade or close actions.</div></section>
                          {position.settlementLegs?.length ? <section><strong className="text-[var(--text-primary)]">Settlement provenance</strong><div className="mt-1 grid min-w-0 gap-2 lg:grid-cols-2">{position.settlementLegs.map((leg) => <div key={leg.venue} data-testid={`${leg.venue}-settlement-technical`} className="min-w-0 rounded border border-[var(--border-subtle)] px-3 py-2"><div className="font-semibold capitalize text-[var(--text-primary)]">{leg.venue} {leg.side.toUpperCase()}</div><dl className="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"><dt>Lifecycle</dt><dd className="break-words">{leg.lifecycleState.replaceAll('_', ' ')}</dd><dt>Credit</dt><dd className="break-words">{leg.creditState.replaceAll('_', ' ')}</dd><dt>Market ID</dt><dd className="break-all font-mono">{leg.marketId || 'Unavailable'}</dd><dt>Outcome ID</dt><dd className="break-all font-mono">{leg.outcomeId || 'Unavailable'}</dd><dt>Winning side</dt><dd>{leg.resolutionWinningSide?.toUpperCase() || 'Unavailable'}</dd><dt>Resolution source</dt><dd className="break-all font-mono">{leg.resolutionSource || 'Unavailable'}</dd><dt>Detected</dt><dd className="break-words">{leg.resolutionDetectedAt ? new Date(leg.resolutionDetectedAt).toLocaleString() : 'Unavailable'}</dd><dt>Cash available</dt><dd className="break-words">{leg.cashAvailableAt ? new Date(leg.cashAvailableAt).toLocaleString() : 'Unavailable'}</dd></dl></div>)}</div></section> : null}
                          <div className="grid min-w-0 gap-2 lg:grid-cols-2" aria-label="Exact placed venue identities">
                            <div data-testid="kalshi-placed-identity" className="min-w-0 rounded border border-[var(--border-subtle)] px-3 py-2"><strong className="text-[var(--text-primary)]">Kalshi placed identity</strong><dl className="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"><dt>Selected market choice</dt><dd className={hasCanonicalOutcomes ? 'text-[var(--text-primary)]' : 'text-[var(--status-warning)]'}>{hasCanonicalOutcomes ? position.kalshiOutcomeLabel!.trim() : 'Unavailable'}</dd><dt>Side</dt><dd>{position.kalshiSide.toUpperCase()}</dd><dt>Platform question</dt><dd className="break-words">{position.kalshiMarketQuestion?.trim() || 'Unavailable'}</dd><dt>Ticker</dt><dd className="break-all font-mono">{position.kalshiTicker || 'Unavailable'}</dd></dl></div>
                            <div data-testid="polymarket-placed-identity" className="min-w-0 rounded border border-[var(--border-subtle)] px-3 py-2"><strong className="text-[var(--text-primary)]">Polymarket placed identity</strong><dl className="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"><dt>Selected market choice</dt><dd className={hasCanonicalOutcomes ? 'text-[var(--text-primary)]' : 'text-[var(--status-warning)]'}>{hasCanonicalOutcomes ? position.pmOutcomeLabel!.trim() : 'Unavailable'}</dd><dt>Side</dt><dd>{position.pmSide.toUpperCase()}</dd><dt>Platform question</dt><dd className="break-words">{position.pmMarketQuestion?.trim() || 'Unavailable'}</dd><dt>Condition ID</dt><dd className="break-all font-mono">{position.pmConditionId || 'Unavailable'}</dd><dt>Held token</dt><dd className="break-all font-mono">{position.pmEntryTokenId || 'Unavailable'}</dd></dl></div>
                          </div>
                          <div data-testid="entry-arb-profit-detail"><strong className="text-[var(--text-primary)]">Entry Arb Profit provenance</strong><div>{ENTRY_ARB_PROFIT_DESCRIPTION}.</div>{entryArbProfit.detail ? <div>{entryArbProfit.detail}</div> : <div className="text-[var(--status-warning)]">Placement snapshot provenance unavailable</div>}{!entryArbProfit.available && <div className="font-semibold text-[var(--status-warning)]">{entryArbProfit.reason}</div>}</div>
                          {entryCostAvailable && position.kalshiEntryGrossMicrocents != null && position.pmEntryGrossMicrocents != null && <section className="space-y-2"><div data-testid="combined-entry-cost" className="flex items-center justify-between gap-3 rounded border border-[var(--border-strong)] px-3 py-2 font-semibold text-[var(--text-primary)]"><span>Reconciled Buy Cost</span><span className="tabular-nums">{formatExactMicrocents(position.totalCostCents * 1_000_000)}</span></div><div data-testid="entry-cost-reconciliation">Gross fills {formatExactMicrocents(position.kalshiEntryGrossMicrocents + position.pmEntryGrossMicrocents)} · {feeSplitAvailable ? <>Entry fees: Kalshi {formatExactMicrocents((position.kalshiEntryFeeCents ?? 0) * 1_000_000)} · Polymarket {formatExactMicrocents((position.pmEntryFeeCents ?? 0) * 1_000_000)}.</> : <>Entry fees: {formatExactMicrocents(unallocatedEntryFeeCents * 1_000_000)} legacy aggregate; platform split unavailable.</>}{position.entryCostRoundingDeltaMicrocents ? ` Currency rounding delta: ${formatExactMicrocents(position.entryCostRoundingDeltaMicrocents)}.` : ' No currency rounding delta.'}{position.entryRecordSource ? ` Evidence: ${position.entryRecordSource}${position.entryRecordedAt ? ` at ${position.entryRecordedAt}` : ''}.` : ''}</div><div className="grid gap-2 lg:grid-cols-2">{([['kalshi', position.kalshiEntryFills], ['polymarket', position.pmEntryFills]] as const).map(([venue, fills]) => fills?.length ? <div key={venue} data-testid={`${venue}-entry-fills`} className="min-w-0 rounded border border-[var(--border-subtle)] px-2 py-2 font-mono">{fills.map((fill, index) => <div key={`${fill.priceMicrocents}-${fill.sizeMicrounits}-${index}`} className="break-words">{fill.authority === 'persisted_position_aggregate' ? 'Persisted aggregate' : `Fill ${index + 1}`}: {(fill.sizeMicrounits / 1_000_000).toFixed(6)} units @ {(fill.priceMicrocents / 1_000_000).toFixed(6)}¢</div>)}</div> : <div key={venue} className="text-[var(--status-warning)]">{venue === 'kalshi' ? 'Kalshi' : 'Polymarket'} detailed fill ladder unavailable</div>)}</div></section>}
                          <section className="grid min-w-0 gap-2 lg:grid-cols-2" aria-label="Persisted price provenance">{([['Kalshi', kalshiSnapshot], ['Polymarket', polymarketSnapshot]] as const).map(([venue, snapshot]) => <div key={venue} className="min-w-0 rounded border border-[var(--border-subtle)] px-3 py-2"><strong className="text-[var(--text-primary)]">{venue} price provenance</strong><div className="break-words">{snapshot.source ? snapshot.source.replaceAll('-', ' ') : 'No persisted source'}{snapshot.observedAt ? ` · observed ${timeAgo(snapshot.observedAt)} · ${new Date(snapshot.observedAt).toLocaleString()}` : ''}</div>{snapshot.markFailureReason && <div className="break-words">{snapshot.markFailureReason}</div>}{snapshot.failureReason && <div className="break-words">Separate close evidence: {snapshot.failureReason}</div>}{snapshot.identity && <div className="break-all font-mono">{snapshot.identity.marketId || 'missing market'} · {snapshot.identity.side.toUpperCase()}{snapshot.identity.tokenId ? ` · token ${snapshot.identity.tokenId}` : ''}</div>}</div>)}</section>
                          <section className="grid min-w-0 gap-2 lg:grid-cols-2" aria-label="Persisted fee authority"><div data-testid="kalshi-fee-authority" className="min-w-0 rounded border border-[var(--border-subtle)] px-3 py-2"><strong className="text-[var(--text-primary)]">Kalshi fee authority</strong><div className="break-all">{position.kalshiExitFeeSource && position.kalshiExitFeeVersion ? `${position.kalshiExitFeeSource} · ${position.kalshiExitFeeVersion}${position.kalshiExitFeeObservedAt ? ` · observed ${new Date(position.kalshiExitFeeObservedAt).toLocaleString()}` : ''}` : 'Unavailable'}</div></div><div data-testid="polymarket-fee-authority" className="min-w-0 rounded border border-[var(--border-subtle)] px-3 py-2"><strong className="text-[var(--text-primary)]">Polymarket fee authority</strong><div className="break-all">{position.pmExitFeeSource && position.pmExitFeeVersion ? `${position.pmExitFeeSource} · ${position.pmExitFeeVersion}${position.pmExitFeeObservedAt ? ` · observed ${new Date(position.pmExitFeeObservedAt).toLocaleString()}` : ''}` : 'Unavailable'}</div></div></section>
                        </div>
                      </details>
                      </div>
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
          {sortedPositions.length === 0 && <div className="py-10 text-center text-sm text-[var(--text-secondary)]">No {filter === 'all' ? '' : `${filter} `}verified BotTrader positions for these filters.</div>}
        </div>
      </div>

      {productionConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="production-confirm-title" onClick={() => setProductionConfirmOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-[var(--status-negative)]/60 bg-[var(--surface-workspace)] p-5" onClick={(event) => event.stopPropagation()}>
            <h3 id="production-confirm-title" className="flex items-center gap-2 font-semibold text-[var(--status-negative)]"><AlertTriangle className="h-5 w-5" /> Switch to production?</h3>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">Production can place real-money orders only when the server-side execution mode, readiness gates, and authorization checks permit it. Type <strong className="text-[var(--text-primary)]">PRODUCTION</strong> to continue.</p>
            <input autoFocus value={productionConfirmation} onChange={(event) => setProductionConfirmation(event.target.value)} aria-label="Production confirmation" placeholder="PRODUCTION" className="mt-4 min-h-11 w-full rounded-lg border border-[var(--status-negative)]/50 bg-[var(--surface-panel)] px-3 font-mono text-sm outline-none" />
            <div className="mt-4 flex justify-end gap-2"><button onClick={() => setProductionConfirmOpen(false)} className="min-h-11 rounded-lg border border-[var(--border-strong)] px-4 text-sm">Cancel</button><button disabled={productionConfirmation !== 'PRODUCTION' || saving} onClick={() => { setProductionConfirmOpen(false); void saveSetting('bot.mode', 'production', 'PRODUCTION'); }} className="min-h-11 rounded-lg bg-[var(--status-negative)] px-4 text-sm font-semibold text-white disabled:opacity-40">Confirm production</button></div>
          </div>
        </div>
      )}
      </div>}
    </section>
  );
}
