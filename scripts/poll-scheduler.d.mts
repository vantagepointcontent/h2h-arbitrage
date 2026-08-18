export interface ScheduledMarket {
  id: string;
  createdAt?: string;
  expiryDate?: string | null;
  lastScanResult?: { scannedAt?: string | null; matchStatus?: string; priceResolved?: boolean } | null;
  [key: string]: unknown;
}

export interface SchedulerItem {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextDueAt: string;
  inProgress: boolean;
  leaseOwnerId?: string | null;
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  failureReason: string | null;
  retryCount: number;
  freshnessSlaMs: number;
}

export type SchedulerState = Record<string, SchedulerItem>;

export function buildSchedulerState(
  markets: ScheduledMarket[],
  persisted?: Record<string, Partial<SchedulerItem>>,
  now?: number,
  freshnessSlaMs?: number,
): SchedulerState;
export function isEligibleMarket(market: ScheduledMarket, now?: number): boolean;
export function parseBoundedNumber(
  value: unknown, fallback: number, minimum: number, maximum: number, integer?: boolean,
): number;
export function minimumConcurrencyForSla(
  eligibleCount: number, timeoutMs: number, freshnessSlaMs: number,
): number;
export function selectDueMarkets<T extends ScheduledMarket>(
  markets: T[], state: SchedulerState, now?: number, limit?: number,
): T[];
export function markAttemptStarted(
  item: SchedulerItem,
  now?: number,
  lease?: { ownerId?: string; token?: string; expiresAt?: string } | null,
): void;
export function completeAttempt(
  item: SchedulerItem,
  outcome: { ok: boolean; error?: string; retryAt?: number; retryWithoutPenalty?: boolean },
  now?: number,
  freshnessSlaMs?: number,
  requestedIntervalMs?: number,
): void;
export function schedulerLeaseCanStart(
  item: SchedulerItem | null | undefined,
  lease: { token?: string; expiresAt?: string } | null | undefined,
  now?: number,
): boolean;
export function schedulerLeaseMatches(
  item: SchedulerItem | null | undefined,
  leaseToken: string,
  now?: number,
): boolean;
export function schedulerMetrics(
  markets: ScheduledMarket[], state: SchedulerState, now?: number, freshnessSlaMs?: number,
): {
  eligibleCount: number;
  dueCount: number;
  overdueCount: number;
  failedCount: number;
  inProgressCount: number;
  oldestSuccessAgeMs: number;
};
