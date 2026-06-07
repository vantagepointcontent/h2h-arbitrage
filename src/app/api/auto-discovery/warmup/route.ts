import { NextResponse } from 'next/server';
import {
  startScheduler,
  isSchedulerRunning,
  SCAN_INTERVAL_MS,
} from '@/lib/auto-discovery';

/** GET /api/auto-discovery/warmup — Ensure scheduler is running.
 * Hit this from PM2 post-ready or health-check to guarantee the
 * background cycle starts even when no user traffic arrives. */
export async function GET(): Promise<NextResponse> {
  startScheduler(); // Idempotent — safe to call repeatedly
  return NextResponse.json({
    schedulerRunning: isSchedulerRunning(),
    intervalMs: SCAN_INTERVAL_MS,
  });
}
