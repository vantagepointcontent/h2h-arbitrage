/**
 * Auto-Execute / One-Click Trade — simultaneous API order execution
 *
 * SAFETY: This module defaults to DRY RUN mode. No real orders are placed
 * unless explicitly enabled via environment variable.
 *
 * Flow:
 * 1. User clicks "Execute" on an arb opportunity
 * 2. System re-checks prices within 1s
 * 3. Calculates exact order sizes based on liquidity
 * 4. Places orders simultaneously on both platforms (or simulates in dry-run)
 * 5. Reports fill status, actual prices, actual profit
 * 6. If one leg fails, cancels the other immediately (rollback)
 */

// ─── Types ────────────────────────────────────────────────────────

export type OrderType = 'limit' | 'market';
export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filled' | 'partial' | 'rejected' | 'cancelled' | 'expired';

export interface OrderRequest {
  platform: 'kalshi' | 'polymarket';
  marketId: string;
  ticker?: string;      // Kalshi ticker
  conditionId?: string; // Polymarket condition ID
  side: OrderSide;
  outcome: 'yes' | 'no';
  size: number;         // dollar amount
  price: number;        // limit price (0-1)
  orderType: OrderType;
}

export interface OrderResult {
  platform: 'kalshi' | 'polymarket';
  status: OrderStatus;
  filledSize?: number;
  filledPrice?: number;
  orderId?: string;
  error?: string;
  timestamp: string;
}

export interface ExecutionRequest {
  arbId: string;
  marketTitle: string;
  kalshiOrder: OrderRequest;
  polymarketOrder: OrderRequest;
  estimatedProfit: number;
  maxSlippagePct: number;   // abort if price moves more than this
  timeoutMs: number;         // cancel both if not filled within this
  dryRun: boolean;           // if true, simulate without placing real orders
}

export interface ExecutionResult {
  success: boolean;
  kalshiResult: OrderResult;
  polymarketResult: OrderResult;
  actualProfit?: number;
  netExposure?: number;      // if partial fills, the net dollar exposure
  rollbackExecuted: boolean;
  executionTimeMs: number;
  error?: string;
}

// ─── Safety Config ────────────────────────────────────────────────

export interface SafetyLimits {
  maxPositionSize: number;      // max $ per trade
  dailyLossLimit: number;        // stop if daily losses exceed this
  maxSlippagePct: number;        // abort if price moves more than this
  orderTimeoutMs: number;        // cancel if not filled within this
  dryRunMode: boolean;           // if true, never place real orders
}

export function getSafetyLimitsFromEnv(): SafetyLimits {
  return {
    maxPositionSize: parseFloat(process.env.H2H_MAX_POSITION_SIZE ?? '') || 1000,
    dailyLossLimit: parseFloat(process.env.H2H_DAILY_LOSS_LIMIT ?? '') || 500,
    maxSlippagePct: parseFloat(process.env.H2H_MAX_SLIPPAGE_PCT ?? '') || 2.0,
    orderTimeoutMs: parseInt(process.env.H2H_ORDER_TIMEOUT_MS ?? '', 10) || 10000,
    dryRunMode: process.env.H2H_DRY_RUN !== 'false',  // DEFAULT: dry run = true
  };
}

// ─── Validation ───────────────────────────────────────────────────

export function validateExecution(req: ExecutionRequest, limits: SafetyLimits): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (req.kalshiOrder.size > limits.maxPositionSize) {
    errors.push(`Kalshi order size $${req.kalshiOrder.size} exceeds max position size $${limits.maxPositionSize}`);
  }
  if (req.polymarketOrder.size > limits.maxPositionSize) {
    errors.push(`Polymarket order size $${req.polymarketOrder.size} exceeds max position size $${limits.maxPositionSize}`);
  }
  if (req.maxSlippagePct > limits.maxSlippagePct) {
    errors.push(`Requested slippage ${req.maxSlippagePct}% exceeds safety limit ${limits.maxSlippagePct}%`);
  }
  if (req.kalshiOrder.price <= 0 || req.kalshiOrder.price >= 1) {
    errors.push(`Kalshi price ${req.kalshiOrder.price} must be between 0 and 1`);
  }
  if (req.polymarketOrder.price <= 0 || req.polymarketOrder.price >= 1) {
    errors.push(`Polymarket price ${req.polymarketOrder.price} must be between 0 and 1`);
  }
  if (req.kalshiOrder.size <= 0 || req.polymarketOrder.size <= 0) {
    errors.push('Order sizes must be positive');
  }

  return { valid: errors.length === 0, errors };
}

// ─── Dry Run Simulator ──────────────────────────────────────────

function simulateOrder(req: OrderRequest): OrderResult {
  // Simulate a successful fill at the requested price
  // Add small random slippage (0-0.5%)
  const slippage = (Math.random() - 0.5) * 0.005;
  const filledPrice = Math.max(0.01, Math.min(0.99, req.price + slippage));
  const fillRatio = 0.85 + Math.random() * 0.15; // 85-100% fill

  return {
    platform: req.platform,
    status: fillRatio >= 0.99 ? 'filled' : 'partial',
    filledSize: req.size * fillRatio,
    filledPrice,
    orderId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };
}

// ─── Execution Engine ────────────────────────────────────────────

export async function executeArb(req: ExecutionRequest): Promise<ExecutionResult> {
  const startTime = Date.now();
  const limits = getSafetyLimitsFromEnv();

  // Force dry run if safety limits require it
  const effectiveDryRun = req.dryRun || limits.dryRunMode;

  // Validate
  const validation = validateExecution(req, limits);
  if (!validation.valid) {
    return {
      success: false,
      kalshiResult: emptyResult('kalshi', 'rejected'),
      polymarketResult: emptyResult('polymarket', 'rejected'),
      rollbackExecuted: false,
      executionTimeMs: Date.now() - startTime,
      error: validation.errors.join('; '),
    };
  }

  // Execute both legs simultaneously
  let kalshiResult: OrderResult;
  let polymarketResult: OrderResult;

  if (effectiveDryRun) {
    // Dry run: simulate both orders
    [kalshiResult, polymarketResult] = await Promise.all([
      Promise.resolve(simulateOrder(req.kalshiOrder)),
      Promise.resolve(simulateOrder(req.polymarketOrder)),
    ]);
  } else {
    // REAL EXECUTION — not implemented yet
    // This would call Kalshi and Polymarket trading APIs
    // Requires authenticated sessions and API keys
    return {
      success: false,
      kalshiResult: emptyResult('kalshi', 'rejected'),
      polymarketResult: emptyResult('polymarket', 'rejected'),
      rollbackExecuted: false,
      executionTimeMs: Date.now() - startTime,
      error: 'Real execution not implemented. Set H2H_DRY_RUN=true (default) to simulate.',
    };
  }

  // Check for failures and rollback
  let rollbackExecuted = false;
  const kalshiFailed = kalshiResult.status === 'rejected' || kalshiResult.status === 'cancelled';
  const polymarketFailed = polymarketResult.status === 'rejected' || polymarketResult.status === 'cancelled';

  if (kalshiFailed || polymarketFailed) {
    // Rollback: cancel the successful leg
    if (!kalshiFailed && polymarketFailed) {
      kalshiResult = { ...kalshiResult, status: 'cancelled' };
      rollbackExecuted = true;
    } else if (!polymarketFailed && kalshiFailed) {
      polymarketResult = { ...polymarketResult, status: 'cancelled' };
      rollbackExecuted = true;
    }
  }

  // Calculate actual profit and net exposure
  let actualProfit: number | undefined;
  let netExposure: number | undefined;

  if (kalshiResult.filledSize && polymarketResult.filledSize && kalshiResult.filledPrice && polymarketResult.filledPrice) {
    const kalshiFilled = kalshiResult.filledSize;
    const pmFilled = polymarketResult.filledSize;
    const minFill = Math.min(kalshiFilled, pmFilled);
    const maxFill = Math.max(kalshiFilled, pmFilled);
    netExposure = maxFill - minFill; // unmatched exposure

    // Profit = minFill * (1 - buyYesPrice - buyNoPrice) — simplified
    const spread = 1 - kalshiResult.filledPrice - polymarketResult.filledPrice;
    actualProfit = minFill * spread;
  }

  const success = !rollbackExecuted &&
    kalshiResult.status !== 'rejected' &&
    polymarketResult.status !== 'rejected';

  return {
    success,
    kalshiResult,
    polymarketResult,
    actualProfit,
    netExposure,
    rollbackExecuted,
    executionTimeMs: Date.now() - startTime,
  };
}

function emptyResult(platform: 'kalshi' | 'polymarket', status: OrderStatus): OrderResult {
  return {
    platform,
    status,
    timestamp: new Date().toISOString(),
  };
}

// ─── Audit Log ───────────────────────────────────────────────────

export interface AuditLogEntry {
  timestamp: string;
  arbId: string;
  marketTitle: string;
  dryRun: boolean;
  kalshiOrder: OrderRequest;
  polymarketOrder: OrderRequest;
  result: ExecutionResult;
  estimatedProfit: number;
}

const auditLog: AuditLogEntry[] = [];

export function logExecution(entry: AuditLogEntry): void {
  auditLog.push(entry);
  // Keep last 1000 entries
  if (auditLog.length > 1000) {
    auditLog.shift();
  }
}

export function getAuditLog(limit: number = 50): AuditLogEntry[] {
  return auditLog.slice(-limit);
}

export function clearAuditLog(): void {
  auditLog.length = 0;
}