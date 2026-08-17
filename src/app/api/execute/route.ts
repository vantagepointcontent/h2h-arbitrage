import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import {
  executeArb,
  getSafetyLimitsFromEnv,
  logExecution,
  getAuditLog,
  ExecutionRequest,
} from '@/lib/auto-execute';
import {
  getCredentialStatus,
  saveCredential,
  removeCredential,
  CREDENTIAL_KEYS,
} from '@/lib/execution-creds';
import { getExecutionMode, setSettings } from '@/lib/settings';
import { applyEmergencyStop, executionModeToDryRun } from '@/lib/execution-mode';
import { persistExecution } from '@/lib/persistence';
import logger from '@/lib/logger';
import { validateCalculationEnvelope, type CalculationLeg } from '@/lib/calculation-envelope';

const MANUAL_ENVELOPE_MAX_AGE_MS = 30_000;
const MANUAL_ENVELOPE_MAX_FUTURE_SKEW_MS = 5_000;
const MANUAL_FEE_AUTHORITY_MAX_AGE_MS = 86_400_000;

function requireFreshTimestamp(value: string | null, label: string, nowMs: number, maxAgeMs = MANUAL_ENVELOPE_MAX_AGE_MS): void {
  if (!value) throw new Error(`${label} is unavailable`);
  const observedMs = Date.parse(value);
  if (!Number.isFinite(observedMs)) throw new Error(`${label} is invalid`);
  if (observedMs > nowMs + MANUAL_ENVELOPE_MAX_FUTURE_SKEW_MS) throw new Error(`${label} is in the future`);
  if (nowMs - observedMs > maxAgeMs) throw new Error(`${label} is stale`);
}

function requireMatchingLeg(
  leg: CalculationLeg | undefined,
  venue: 'kalshi' | 'polymarket',
  instrumentId: string | undefined,
  outcome: 'yes' | 'no',
): CalculationLeg {
  if (!leg) throw new Error(`canonical ${venue} leg is missing`);
  if (!instrumentId || leg.instrumentId.toLowerCase() !== instrumentId.toLowerCase()) {
    throw new Error(`canonical ${venue} instrument mismatch`);
  }
  if (leg.side !== outcome) throw new Error(`canonical ${venue} outcome mismatch`);
  if (leg.outcomeId.toLowerCase() !== outcome) throw new Error(`canonical ${venue} outcome ID mismatch`);
  if (leg.action !== 'buy') throw new Error(`canonical ${venue} action must be buy`);
  return leg;
}

/** Fail closed before venue I/O; quantities, prices, and P&L come from the canonical one-share ledger. */
export function canonicalizeManualExecutionRequest(request: ExecutionRequest, nowMs = Date.now()): ExecutionRequest {
  if (!request.calculationEnvelope) throw new Error('calculation envelope is required');
  const envelope = validateCalculationEnvelope(request.calculationEnvelope);
  if (envelope.scope !== 'opportunity' || envelope.status !== 'executable') {
    throw new Error(`calculation envelope is not executable (${envelope.status})`);
  }
  if (envelope.requestedQuantityMicros !== 1_000_000 || envelope.executableQuantityMicros !== 1_000_000) {
    throw new Error('manual execution requires exactly one matched share');
  }
  if (envelope.legs.length !== 2
    || envelope.legs.filter((leg) => leg.venue.toLowerCase() === 'kalshi').length !== 1
    || envelope.legs.filter((leg) => leg.venue.toLowerCase() === 'polymarket').length !== 1) {
    throw new Error('manual execution requires exactly one Kalshi leg and one Polymarket leg');
  }
  const netPnlMicros = envelope.totals.netPnlMicros;
  if (netPnlMicros == null) throw new Error('canonical net P&L is unavailable');
  requireFreshTimestamp(envelope.calculatedAt, 'calculation envelope', nowMs);

  const kalshiLeg = requireMatchingLeg(
    envelope.legs.find((leg) => leg.venue.toLowerCase() === 'kalshi'),
    'kalshi',
    request.kalshiOrder.ticker,
    request.kalshiOrder.outcome,
  );
  const polymarketLeg = requireMatchingLeg(
    envelope.legs.find((leg) => leg.venue.toLowerCase() === 'polymarket'),
    'polymarket',
    request.polymarketOrder.conditionId,
    request.polymarketOrder.outcome,
  );
  requireFreshTimestamp(kalshiLeg.bookObservedAt, 'Kalshi book observation', nowMs);
  requireFreshTimestamp(polymarketLeg.bookObservedAt, 'Polymarket book observation', nowMs);
  requireFreshTimestamp(kalshiLeg.fee.schedule?.observedAt ?? null, 'Kalshi fee authority', nowMs, MANUAL_FEE_AUTHORITY_MAX_AGE_MS);
  requireFreshTimestamp(polymarketLeg.fee.schedule?.observedAt ?? null, 'Polymarket fee authority', nowMs, MANUAL_FEE_AUTHORITY_MAX_AGE_MS);
  const kalshiVwapMicros = kalshiLeg.vwapPriceMicros;
  const polymarketVwapMicros = polymarketLeg.vwapPriceMicros;
  if (kalshiVwapMicros == null || polymarketVwapMicros == null) {
    throw new Error('canonical VWAP is unavailable');
  }

  const kalshiPrice = kalshiVwapMicros / 1_000_000;
  const polymarketPrice = polymarketVwapMicros / 1_000_000;
  return {
    ...request,
    calculationEnvelope: envelope,
    estimatedProfit: netPnlMicros / 1_000_000,
    scanTime: envelope.calculatedAt ?? undefined,
    bestPriceFound: true,
    kalshiOrder: { ...request.kalshiOrder, contracts: 1, price: kalshiPrice, size: kalshiPrice },
    polymarketOrder: { ...request.polymarketOrder, contracts: 1, price: polymarketPrice, size: polymarketPrice },
  };
}

/**
 * HOOKUP-04 (FEAT-006): MANUAL trade execution + credential management.
 *
 * ── POLICY: MANUAL EXECUTION ONLY ────────────────────────────────────
 * This endpoint is the ONLY path to executeArb(). It must only ever be
 * called from an explicit user action (Execute button / operator request).
 * Nothing in the poller, watcher, scheduler, or any automated pipeline may
 * call it. Building an auto-execute pipeline requires an explicit product
 * decision by Victor — do not wire it without one.
 * ─────────────────────────────────────────────────────────────────────
 *
 * GET  /api/execute                 — safety limits + credential status + audit log
 * POST /api/execute
 *   { action: 'execute', request: ExecutionRequest }   — manual execution (dry-run by default)
 *   { action: 'set-credential', key, value }           — store a credential (.env.local, 0600)
 *   { action: 'remove-credential', key }               — remove a credential
 */

export async function GET(): Promise<NextResponse> {
  try {
    const [creds, mode] = await Promise.all([
      getCredentialStatus(),
      getExecutionMode().catch(() => 'paper' as const),
    ]);
    return NextResponse.json({
      limits: { ...getSafetyLimitsFromEnv(), dryRunMode: executionModeToDryRun(mode) },
      credentials: creds,
      credentialKeys: CREDENTIAL_KEYS,
      mode,
      auditLog: getAuditLog(50),
      policy: 'manual-only',
    });
  } catch (err) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const action = body?.action;

    if (action === 'set-credential') {
      const { key, value } = body;
      if (typeof key !== 'string' || typeof value !== 'string') {
        return NextResponse.json({ error: 'Missing key or value' }, { status: 400 });
      }
      if (!(CREDENTIAL_KEYS as readonly string[]).includes(key)) {
        return NextResponse.json({ error: `Key not allowed: ${key}` }, { status: 400 });
      }
      await saveCredential(key, value);
      logger.info('[execute] credential stored', { key }); // key name only, never the value
      return NextResponse.json({ success: true, credentials: await getCredentialStatus() });
    }

    if (action === 'remove-credential') {
      const { key } = body;
      if (typeof key !== 'string') {
        return NextResponse.json({ error: 'Missing key' }, { status: 400 });
      }
      if (!(CREDENTIAL_KEYS as readonly string[]).includes(key)) {
        return NextResponse.json({ error: `Key not allowed: ${key}` }, { status: 400 });
      }
      await removeCredential(key);
      logger.info('[execute] credential removed', { key });
      return NextResponse.json({ success: true, credentials: await getCredentialStatus() });
    }

    if (action === 'execute') {
      const request = body?.request as ExecutionRequest | undefined;
      if (!request || !request.kalshiOrder || !request.polymarketOrder) {
        return NextResponse.json({ error: 'Missing execution request' }, { status: 400 });
      }
      let canonicalRequest: ExecutionRequest;
      try {
        canonicalRequest = canonicalizeManualExecutionRequest(request);
      } catch (error) {
        return NextResponse.json({ error: clientSafeError(error) }, { status: 400 });
      }

      // The server-side mode is the sole authority. Request/env dry-run flags
      // cannot bypass or alter it.
      const mode = await getExecutionMode().catch(() => 'paper' as const);
      if (mode === 'live-gated') {
        return NextResponse.json(
          { error: 'Execution is live-gated. Real orders are blocked by the emergency stop.' },
          { status: 403 },
        );
      }
      const effective: ExecutionRequest = {
        ...canonicalRequest,
        dryRun: executionModeToDryRun(mode),
      };

      // Real execution additionally requires complete credentials.
      if (!effective.dryRun) {
        const creds = await getCredentialStatus();
        if (!creds.allReady) {
          return NextResponse.json(
            { error: 'Real execution requires complete Kalshi + Polymarket credentials (Settings → Trading Credentials).' },
            { status: 403 },
          );
        }
      }

      logger.info('[execute] MANUAL execution requested', {
        arbId: effective.arbId,
        marketTitle: effective.marketTitle,
        dryRun: effective.dryRun,
        estimatedProfit: effective.estimatedProfit,
      });

      const result = await executeArb(effective);
      logExecution({
        timestamp: new Date().toISOString(),
        arbId: effective.arbId,
        marketTitle: effective.marketTitle,
        dryRun: effective.dryRun,
        kalshiOrder: effective.kalshiOrder,
        polymarketOrder: effective.polymarketOrder,
        result,
        estimatedProfit: effective.estimatedProfit,
      });
      // TRADES-001: durable copy — in-memory auditLog dies on restart
      try {
        await persistExecution({
          timestamp: new Date().toISOString(),
          arbId: effective.arbId,
          marketTitle: effective.marketTitle,
          dryRun: effective.dryRun,
          success: result.success,
          strategy: effective.strategy ?? null,
          kalshiOrder: effective.kalshiOrder,
          polymarketOrder: effective.polymarketOrder,
          result,
          estimatedProfit: effective.estimatedProfit,
          steps: result.steps,
          calculationEnvelope: effective.calculationEnvelope
            ? { ...effective.calculationEnvelope, scope: 'execution' }
            : undefined,
        });
      } catch (error) {
        logger.error('[execute] execution completed but durable persistence failed', { error: String(error), arbId: effective.arbId });
        return NextResponse.json({
          success: false,
          executionCompleted: true,
          error: 'Execution completed, but its durable audit record could not be saved. Preserve the returned venue result and escalate immediately.',
          result,
          dryRun: effective.dryRun,
          mode,
        }, { status: 500 });
      }

      return NextResponse.json({ success: result.success, result, dryRun: effective.dryRun, mode });
    }

    if (action === 'emergency-stop') {
      const mode = await getExecutionMode().catch(() => 'paper' as const);
      const nextMode = applyEmergencyStop(mode);
      if (nextMode !== mode) await setSettings({ 'execute.mode': nextMode });
      logger.warn('[execute] emergency stop activated', { previousMode: mode, mode: nextMode });
      return NextResponse.json({ success: true, mode: nextMode });
    }

    if (action === 'test-connection') {
      // TRADES-001: validate stored credentials by hitting a read-only
      // authenticated endpoint on each platform. Never places orders.
      const platform = body?.platform;
      const results: Record<string, { ok: boolean; detail: string }> = {};

      if (platform === 'kalshi' || platform === 'both') {
        results.kalshi = await testKalshiConnection();
      }
      if (platform === 'polymarket' || platform === 'both') {
        results.polymarket = await testPmConnection();
      }

      const allOk = Object.values(results).every((r) => r.ok);
      return NextResponse.json({ success: allOk, results });
    }

    return NextResponse.json(
      { error: 'Unknown action. Use "execute", "emergency-stop", "set-credential", "remove-credential", or "test-connection".' },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

/* ── Credential validation: read-only auth checks ── */

async function testKalshiConnection(): Promise<{ ok: boolean; detail: string }> {
  try {
    const keyId = process.env.KALSHI_API_KEY_ID;
    const privateKey = process.env.KALSHI_API_PRIVATE_KEY;
    if (!keyId || !privateKey) {
      return { ok: false, detail: 'Missing KALSHI_API_KEY_ID or KALSHI_API_PRIVATE_KEY' };
    }
    // Hit GET /portfolio/orders (read-only, authed) — validates RSA signing works.
    const { makeKalshiAuthHeaders } = await import('@/lib/kalshi-auth');
    const path = '/trade-api/v2/portfolio/orders';
    const res = await fetch('https://api.elections.kalshi.com' + path, {
      method: 'GET',
      headers: makeKalshiAuthHeaders('GET', path),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true, detail: `Connected (HTTP ${res.status})` };
    if (res.status === 401 || res.status === 403) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, detail: `Auth rejected: ${(typeof data === 'object' && data && typeof (data as Record<string, unknown>).error === 'object' && (data as Record<string, unknown>).error && typeof ((data as Record<string, unknown>).error as Record<string, unknown>).message === 'string' ? ((data as Record<string, unknown>).error as Record<string, unknown>).message : res.status)}` };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `Connection error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function testPmConnection(): Promise<{ ok: boolean; detail: string }> {
  try {
    const pk = process.env.POLYMARKET_PRIVATE_KEY;
    const apiKey = process.env.POLYMARKET_API_KEY;
    const secret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_API_PASSPHRASE;
    if (!pk || !apiKey || !secret || !passphrase) {
      return { ok: false, detail: 'Missing Polymarket credentials (need all 4 keys)' };
    }
    // Derive L2 API credentials and hit GET /data/orders — read-only.
    const { ClobClient } = await import('@polymarket/clob-client');
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { polygon } = await import('viem/chains');

    const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
    const wallet = createWalletClient({ account, chain: polygon, transport: http('https://polygon-rpc.com') });
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet, { key: apiKey, secret, passphrase });

    // getOrders() is read-only — validates L2 auth + wallet signing.
    const orders = await client.getOrders();
    return { ok: true, detail: `Connected (${Array.isArray(orders) ? orders.length : 0} open orders)` };
  } catch (err) {
    return { ok: false, detail: `Connection error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
