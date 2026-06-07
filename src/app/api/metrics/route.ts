import { NextResponse } from 'next/server';
import { getMetrics, formatPrometheus } from '@/lib/health';

/**
 * GET /metrics
 *
 * Prometheus-format metrics endpoint for scraping.
 * Exposes: uptime, health status, consecutive failures, DB/poller/upstream gauges.
 */
export async function GET() {
  const metrics = await getMetrics();
  const body = formatPrometheus(metrics);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
  });
}
