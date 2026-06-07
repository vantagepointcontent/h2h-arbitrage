import { NextResponse } from 'next/server';
import { getHealth } from '@/lib/health';

/**
 * GET /healthz
 *
 * Comprehensive health check endpoint:
 * - Returns 200 when healthy/degraded, 503 when unhealthy (>50% upstream degraded)
 * - Reports uptime, database status, poller status, and upstream API health
 * - Tracks consecutive failures for alerting
 */
export async function GET() {
  const health = await getHealth();

  const statusCode = health.status === 'unhealthy' ? 503 : 200;

  return NextResponse.json(health, {
    status: statusCode,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
  });
}
