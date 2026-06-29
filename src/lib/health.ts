import { promises as fs } from 'fs';
import path from 'path';

/* ──────────────────────────── Types ──────────────────────────── */

export interface UpstreamCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  error?: string;
  lastChecked: string;
}

export interface HealthState {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptimeSeconds: number;
  timestamp: string;
  version: string;
  checks: {
    database: UpstreamCheck;
    poller: UpstreamCheck;
    upstreams: UpstreamCheck[];
  };
  consecutiveFailures: number;
  lastFailure?: string;
}

/* ──────────────────────────── Constants ──────────────────────────── */

const DATA_DIR = path.join(process.cwd(), 'data');
const HEALTH_STATE_FILE = path.join(DATA_DIR, 'health-state.json');
const UPSTREAM_TIMEOUT_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 5;

// Process start time (uptime baseline)
const PROCESS_START = Date.now();

/* ──────────────────────────── Upstream Probes ───────────────────── */

async function probeWithTimeout(url: string, timeoutMs: number): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Use GET instead of HEAD — many APIs (Kalshi) return 404 for HEAD
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    const latency = Date.now() - start;
    return { ok: res.ok, latencyMs: latency };
  } catch (err: unknown) {
    const latency = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: latency, error: msg };
  }
}

/* ──────────────────────────── Database Check ────────────────────── */

export async function checkDatabase(): Promise<UpstreamCheck> {
  const start = Date.now();
  const dataFile = path.join(DATA_DIR, 'saved-markets.json');
  try {
    await fs.access(dataFile);
    const stats = await fs.stat(dataFile);
    const latency = Date.now() - start;
    return {
      name: 'database',
      status: 'healthy',
      latencyMs: latency,
      lastChecked: new Date().toISOString(),
    };
  } catch (err: unknown) {
    const latency = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'database',
      status: 'unhealthy',
      latencyMs: latency,
      error: msg,
      lastChecked: new Date().toISOString(),
    };
  }
}

/* ──────────────────────────── Poller Check ─────────────────────── */

export async function checkPoller(): Promise<UpstreamCheck> {
  const start = Date.now();
  const healthFile = path.join(DATA_DIR, 'poller-health.json');
  try {
    const raw = await fs.readFile(healthFile, 'utf-8');
    const health = JSON.parse(raw);
    const latency = Date.now() - start;
    // Check if poller is recently active (within last 10 minutes)
    const lastSeen = health.lastPingAt ? new Date(health.lastPingAt).getTime() : 0;
    const ageMinutes = (Date.now() - lastSeen) / 60000;
    const status: UpstreamCheck['status'] = ageMinutes > 10 ? 'degraded' : 'healthy';
    return {
      name: 'poller',
      status,
      latencyMs: latency,
      ...(status === 'degraded' ? { error: `Last ping ${ageMinutes.toFixed(1)}min ago` } : {}),
      lastChecked: new Date().toISOString(),
    };
  } catch (err: unknown) {
    const latency = Date.now() - start;
    const isNotFound = typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
    return {
      name: 'poller',
      status: isNotFound ? 'degraded' : 'unhealthy',
      latencyMs: latency,
      error: isNotFound ? 'Poller has not reported health yet' : (err instanceof Error ? err.message : String(err)),
      lastChecked: new Date().toISOString(),
    };
  }
}

/* ──────────────────────────── Upstream API Checks ──────────────── */

const UPSTREAM_PROBES = [
  { name: 'kalshi', url: 'https://external-api.kalshi.com/trade-api/v2/markets?limit=1' },
  { name: 'polymarket_gamma', url: 'https://gamma-api.polymarket.com/markets?limit=1' },
  { name: 'predictionhunt', url: 'https://www.predictionhunt.com/api/v2/markets?limit=1&status=active' },
];

export async function checkUpstreams(): Promise<UpstreamCheck[]> {
  const results = await Promise.all(UPSTREAM_PROBES.map(async (probe) => {
    const result = await probeWithTimeout(probe.url, UPSTREAM_TIMEOUT_MS);
    return {
      name: probe.name,
      status: result.ok ? 'healthy' : 'unhealthy',
      latencyMs: result.latencyMs,
      ...(result.error ? { error: result.error } : {}),
      lastChecked: new Date().toISOString(),
    } satisfies UpstreamCheck;
  }));
  return results;
}

/* ──────────────────────────── Consecutive Failure Tracking ──────── */

interface PersistedHealthState {
  consecutiveFailures: number;
  lastFailure?: string;
  lastSuccess?: string;
}

async function loadFailureState(): Promise<PersistedHealthState> {
  try {
    const raw = await fs.readFile(HEALTH_STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { consecutiveFailures: 0 };
  }
}

async function persistFailureState(state: PersistedHealthState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(HEALTH_STATE_FILE, JSON.stringify(state, null, 2));
}

/* ──────────────────────────── Aggregate Health ─────────────────── */

export async function getHealth(): Promise<HealthState> {
  const [db, poller, upstreams] = await Promise.all([
    checkDatabase(),
    checkPoller(),
    checkUpstreams(),
  ]);

  // Count unhealthy upstreams
  const allChecks = [db, poller, ...upstreams];
  const unhealthyCount = allChecks.filter(c => c.status === 'unhealthy').length;
  const totalChecks = allChecks.length;
  const degradedRatio = unhealthyCount / totalChecks;

  // Determine overall status
  let status: HealthState['status'];
  if (degradedRatio > 0.5) {
    status = 'unhealthy';
  } else if (degradedRatio > 0 || allChecks.some(c => c.status === 'degraded')) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  // Update consecutive failure tracking
  const persisted = await loadFailureState();

  if (status === 'healthy') {
    persisted.consecutiveFailures = 0;
    persisted.lastSuccess = new Date().toISOString();
  } else {
    persisted.consecutiveFailures += 1;
    persisted.lastFailure = new Date().toISOString();
  }
  await persistFailureState(persisted);

  return {
    status,
    uptimeSeconds: Math.floor((Date.now() - PROCESS_START) / 1000),
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    checks: {
      database: db,
      poller,
      upstreams,
    },
    consecutiveFailures: persisted.consecutiveFailures,
    lastFailure: persisted.lastFailure,
  };
}

/* ──────────────────────────── Prometheus Metrics ───────────────── */

export interface Metric {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  value: number;
  labels?: Record<string, string>;
}

export async function getMetrics(): Promise<Metric[]> {
  const health = await getHealth();

  const metrics: Metric[] = [
    // Uptime
    {
      name: 'app_uptime_seconds',
      help: 'Process uptime in seconds',
      type: 'gauge',
      value: health.uptimeSeconds,
    },
    // Overall health: 1=healthy, 0.5=degraded, 0=unhealthy
    {
      name: 'app_health_status',
      help: 'Overall health status (1=healthy, 0.5=degraded, 0=unhealthy)',
      type: 'gauge',
      value: health.status === 'healthy' ? 1 : health.status === 'degraded' ? 0.5 : 0,
    },
    // Consecutive failures
    {
      name: 'app_consecutive_failures',
      help: 'Consecutive health check failures',
      type: 'gauge',
      value: health.consecutiveFailures,
    },
    // Database
    {
      name: 'app_db_healthy',
      help: 'Database connectivity (1=healthy, 0=unhealthy)',
      type: 'gauge',
      value: health.checks.database.status === 'healthy' ? 1 : 0,
    },
    {
      name: 'app_db_check_latency_ms',
      help: 'Database check latency in milliseconds',
      type: 'gauge',
      value: health.checks.database.latencyMs,
    },
    // Poller
    {
      name: 'app_poller_healthy',
      help: 'Poller health (1=healthy, 0.5=degraded, 0=unhealthy)',
      type: 'gauge',
      value: health.checks.poller.status === 'healthy' ? 1 : health.checks.poller.status === 'degraded' ? 0.5 : 0,
    },
    // Upstreams
    ...health.checks.upstreams.map(u => ({
      name: 'app_upstream_healthy',
      help: 'Upstream API health (1=healthy, 0=unhealthy)',
      type: 'gauge' as const,
      value: u.status === 'healthy' ? 1 : 0,
      labels: { name: u.name },
    })),
    ...health.checks.upstreams.map(u => ({
      name: 'app_upstream_latency_ms',
      help: 'Upstream API check latency in milliseconds',
      type: 'gauge' as const,
      value: u.latencyMs,
      labels: { name: u.name },
    })),
  ];

  return metrics;
}

export function formatPrometheus(metrics: Metric[]): string {
  const lines: string[] = [];

  for (const m of metrics) {
    lines.push(`# HELP ${m.help.replace(/'/g, "\\'")}`);
    lines.push(`# TYPE ${m.name} ${m.type}`);

    if (m.labels && Object.keys(m.labels).length > 0) {
      const labelStr = Object.entries(m.labels!)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      lines.push(`${m.name}{${labelStr}} ${m.value}`);
    } else {
      lines.push(`${m.name} ${m.value}`);
    }
  }

  return lines.join('\n') + '\n';
}

/* ──────────────────────────── Export for polling ───────────────── */

export function getProcessStartTime(): number {
  return PROCESS_START;
}
