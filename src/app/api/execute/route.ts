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
import { getSetting } from '@/lib/settings';
import logger from '@/lib/logger';

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
    const [creds, killSwitch] = await Promise.all([
      getCredentialStatus(),
      getSetting<boolean>('execute.killSwitch').catch(() => true),
    ]);
    return NextResponse.json({
      limits: getSafetyLimitsFromEnv(),
      credentials: creds,
      credentialKeys: CREDENTIAL_KEYS,
      killSwitch,
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

      // ── Kill switch: hard stop for ALL execution, dry-run included ──
      const killSwitch = await getSetting<boolean>('execute.killSwitch').catch(() => true);
      if (killSwitch) {
        return NextResponse.json(
          { error: 'Kill switch is ON. Disable execute.killSwitch in Settings to allow execution.' },
          { status: 403 },
        );
      }

      // Server-side dry-run enforcement: request cannot demand a real order;
      // the effective mode is the OR of request.dryRun, settings, and env.
      const settingDryRun = await getSetting<boolean>('execute.dryRun').catch(() => true);
      const effective: ExecutionRequest = {
        ...request,
        dryRun: request.dryRun || settingDryRun,
      };

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

      return NextResponse.json({ success: result.success, result, dryRun: effective.dryRun });
    }

    return NextResponse.json(
      { error: 'Unknown action. Use "execute", "set-credential", or "remove-credential".' },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
