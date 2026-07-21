import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';
import { parseAutoDiscoveryAction, parseAutoDiscoveryStatePatch } from '@/lib/auto-discovery-route-request';
import {
  runAutoDiscovery,
  getState,
  setState,
  togglePause,
  getCategories,
  startScheduler,
  stopScheduler,
  isSchedulerRunning,
  SCAN_INTERVAL_MS,
} from '@/lib/auto-discovery';

/* ──────────────────────────── Routes ──────────────────────────── */

/** GET /api/auto-discovery — Return current state + config. */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const state = getState();
  return NextResponse.json({
    state,
    categories: getCategories(),
    scanIntervalMs: SCAN_INTERVAL_MS,
    schedulerRunning: isSchedulerRunning(),
  });
}

/** POST /api/auto-discovery — Trigger actions.
 * Body: { action: "run" | "pause" | "resume" | "start_scheduler" | "stop_scheduler" }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const parsed = await parseJsonObject(req);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const actionResult = parseAutoDiscoveryAction(parsed.body);
    if ('error' in actionResult) return NextResponse.json({ error: actionResult.error }, { status: 400 });
    const { action } = actionResult;

    if (action === 'run') {
      const result = await runAutoDiscovery();
      return NextResponse.json({
        success: true,
        result,
      });
    }

    if (action === 'pause') {
      const state = togglePause(true);
      return NextResponse.json({ success: true, state });
    }

    if (action === 'resume') {
      const state = togglePause(false);
      return NextResponse.json({ success: true, state });
    }

    if (action === 'start_scheduler') {
      startScheduler();
      return NextResponse.json({
        success: true,
        schedulerRunning: isSchedulerRunning(),
      });
    }

    if (action === 'stop_scheduler') {
      stopScheduler();
      return NextResponse.json({
        success: true,
        schedulerRunning: isSchedulerRunning(),
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Internal server error') },
      { status: 500 },
    );
  }
}

/** PATCH /api/auto-discovery — Update state fields.
 * Body: { paused: boolean }
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const parsed = await parseJsonObject(req);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const patch = parseAutoDiscoveryStatePatch(parsed.body);
    if ('error' in patch) return NextResponse.json({ error: patch.error }, { status: 400 });
    const state = getState();
    state.paused = patch.paused;

    setState(state);
    return NextResponse.json({ success: true, state });
  } catch (err: any) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Internal server error') },
      { status: 500 },
    );
  }
}
