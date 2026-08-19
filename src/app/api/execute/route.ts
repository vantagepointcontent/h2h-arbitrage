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
import {
  fetchClobBook,
  fetchClobMarket,
  validateOneShareBookOrder,
  type ClobMarket,
} from '@/lib/polymarket-clob';
import { calculateKalshiFeeQuote, resolveKalshiFeeAuthority } from '@/lib/kalshi-fee-quote';

function resolveBinaryOutcomeTokens(
  market: ClobMarket | null,
  expectedConditionId: string,
): { yes: string; no: string } | null {
  if (!market || typeof market.condition_id !== 'string'
      || market.condition_id.toLowerCase() !== expectedConditionId.toLowerCase()
      || !Array.isArray(market.tokens) || market.tokens.length !== 2) {
    return null;
  }

  const byOutcome: { yes: string[]; no: string[] } = { yes: [], no: [] };
  for (const candidate of market.tokens as unknown[]) {
    if (!candidate || typeof candidate !== 'object') return null;
    const tokenId = (candidate as { token_id?: unknown }).token_id;
    const outcome = (candidate as { outcome?: unknown }).outcome;
    if (typeof tokenId !== 'string' || !tokenId.trim() || typeof outcome !== 'string') return null;
    const normalizedOutcome = outcome.toLowerCase();
    if (normalizedOutcome !== 'yes' && normalizedOutcome !== 'no') return null;
    byOutcome[normalizedOutcome].push(tokenId.trim());
  }

  if (byOutcome.yes.length !== 1 || byOutcome.no.length !== 1 || byOutcome.yes[0] === byOutcome.no[0]) {
    return null;
  }
  return { yes: byOutcome.yes[0], no: byOutcome.no[0] };
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

      // The server-side mode is the sole authority. Request/env dry-run flags
      // cannot bypass or alter it.
      const mode = await getExecutionMode().catch(() => 'paper' as const);
      if (mode === 'live-gated') {
        return NextResponse.json(
          { error: 'Execution is live-gated. Real orders are blocked by the emergency stop.' },
          { status: 403 },
        );
      }
      const kalshiTicker = request.kalshiOrder.ticker ?? request.kalshiOrder.marketId;
      const contracts = request.kalshiOrder.contracts ?? request.kalshiOrder.size / request.kalshiOrder.price;
      const feeAuthority = await resolveKalshiFeeAuthority(kalshiTicker);
      const kalshiFeeQuote = calculateKalshiFeeQuote(feeAuthority, 'taker', [{
        fills: [{ priceCents: request.kalshiOrder.price * 100, contracts }],
      }]);
      let effective: ExecutionRequest = {
        ...request,
        kalshiOrder: { ...request.kalshiOrder, contracts, kalshiFeeQuote },
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
        const pmConditionId = typeof effective.pmConditionId === 'string'
          ? effective.pmConditionId.trim()
          : '';
        const pmTokenId = typeof effective.polymarketOrder.conditionId === 'string'
          ? effective.polymarketOrder.conditionId.trim()
          : '';
        const pmOutcome = effective.polymarketOrder.outcome;
        const parentMarket = pmConditionId
          ? await fetchClobMarket(pmConditionId, { bypassCache: true })
          : null;
        const outcomeTokens = resolveBinaryOutcomeTokens(parentMarket, pmConditionId);
        if (!outcomeTokens) {
          return NextResponse.json(
            { error: 'Polymarket parent token mapping is invalid' },
            { status: 409 },
          );
        }
        if ((pmOutcome !== 'yes' && pmOutcome !== 'no') || outcomeTokens[pmOutcome] !== pmTokenId) {
          return NextResponse.json(
            { error: `Polymarket ${String(pmOutcome).toUpperCase()} token does not match the parent market` },
            { status: 409 },
          );
        }
        const authoritativeBook = pmTokenId
          ? await fetchClobBook(pmTokenId, { bypassCache: true })
          : null;
        const constraint = validateOneShareBookOrder(
          authoritativeBook,
          pmTokenId,
          effective.polymarketOrder.price,
        );
        if (!constraint.valid) {
          return NextResponse.json(
            { error: constraint.blocker ?? 'Polymarket one-share constraint validation failed' },
            { status: 409 },
          );
        }
        effective = {
          ...effective,
          kalshiOrder: { ...effective.kalshiOrder, minimumOrderSize: 1, tickSize: 0.01 },
          polymarketOrder: {
            ...effective.polymarketOrder,
            minimumOrderSize: constraint.minimumOrderSize!,
            tickSize: constraint.tickSize!,
          },
        };
      }

      logger.info('[execute] MANUAL execution requested', {
        arbId: effective.arbId,
        marketTitle: effective.marketTitle,
        dryRun: effective.dryRun,
        estimatedProfit: effective.estimatedProfit,
      });

      const result = await executeArb(effective);
      if (result.kalshiResult.filledContracts != null && result.kalshiResult.filledPrice != null) {
        const evidence = result.kalshiResult.venueEvidence;
        const actualFills = evidence?.fills?.length
          ? evidence.fills.map((fill) => ({
            priceCents: fill.price * 100,
            contracts: fill.quantity,
            liquidityRole: fill.liquidityRole,
          }))
          : [{
            priceCents: result.kalshiResult.filledPrice * 100,
            contracts: result.kalshiResult.filledContracts,
            liquidityRole: evidence?.liquidityRole,
          }];
        const defaultLiquidity = evidence?.liquidityRole ?? 'taker';
        result.kalshiFeeQuote = calculateKalshiFeeQuote(feeAuthority, defaultLiquidity, [{
          fills: actualFills,
          chargedFeeCents: evidence?.chargedFeeCents ?? result.kalshiResult.chargedFeeCents,
        }]);
      } else {
        result.kalshiFeeQuote = kalshiFeeQuote;
      }
      // TRADES-001: durable copy — in-memory auditLog dies on restart
      await persistExecution({
        timestamp: new Date().toISOString(),
        arbId: effective.arbId,
        marketTitle: effective.marketTitle,
        dryRun: effective.dryRun,
        success: result.success,
        strategy: (effective as ExecutionRequest & { strategy?: string }).strategy ?? null,
        kalshiOrder: effective.kalshiOrder,
        polymarketOrder: effective.polymarketOrder,
        result,
        estimatedProfit: effective.estimatedProfit,
        steps: result.steps,
        calculationEnvelope: effective.calculationEnvelope
          ? { ...effective.calculationEnvelope, scope: 'execution' }
          : undefined,
      });
      // A terminal response is only publishable after the exact ledger is durable.
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
      const errorMessage = typeof data === 'object' && data !== null
        && 'error' in data && typeof data.error === 'object' && data.error !== null
        && 'message' in data.error && typeof data.error.message === 'string'
        ? data.error.message
        : String(res.status);
      return { ok: false, detail: `Auth rejected: ${errorMessage}` };
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
