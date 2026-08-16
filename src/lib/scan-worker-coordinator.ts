import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { persistRateLimiterMetrics, type RateLimiterMetricRecord } from './persistence';
import { withSqliteBusyRetry } from './sqlite-write-retry';
import logger from './logger';

let telemetryWriteQueue: Promise<void> = Promise.resolve();
const WORKER_TELEMETRY_HEALTH_PATH = path.join(process.cwd(), 'data', 'scan-worker-telemetry-health.json');

export interface WorkerTelemetryWriteHealth {
  lastReceivedAt: string | null;
  lastPersistedAt: string | null;
  lastFailureAt: string | null;
  writeFailures: number;
  error: string | null;
}

let workerTelemetryHealth: WorkerTelemetryWriteHealth = {
  lastReceivedAt: null,
  lastPersistedAt: null,
  lastFailureAt: null,
  writeFailures: 0,
  error: null,
};

async function persistWorkerTelemetryHealth(): Promise<void> {
  const temp = `${WORKER_TELEMETRY_HEALTH_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(workerTelemetryHealth), { mode: 0o600 });
  await rename(temp, WORKER_TELEMETRY_HEALTH_PATH);
}

export async function readWorkerTelemetryWriteHealth(): Promise<WorkerTelemetryWriteHealth> {
  try {
    return JSON.parse(await readFile(WORKER_TELEMETRY_HEALTH_PATH, 'utf8')) as WorkerTelemetryWriteHealth;
  } catch {
    return { ...workerTelemetryHealth };
  }
}

function enqueueWorkerTelemetry(
  records: RateLimiterMetricRecord[],
  persist: (records: RateLimiterMetricRecord[]) => Promise<void>,
): Promise<void> {
  if (records.length === 0) return Promise.resolve();
  workerTelemetryHealth = { ...workerTelemetryHealth, lastReceivedAt: new Date().toISOString() };
  void persistWorkerTelemetryHealth().catch(() => {});
  const operation = telemetryWriteQueue
    .catch(() => undefined)
    .then(() => withSqliteBusyRetry(() => persist(records)))
    .then(async () => {
      workerTelemetryHealth = { ...workerTelemetryHealth, lastPersistedAt: new Date().toISOString(), error: null };
      await persistWorkerTelemetryHealth();
    })
    .catch((error) => {
      workerTelemetryHealth = {
        ...workerTelemetryHealth,
        lastFailureAt: new Date().toISOString(),
        writeFailures: workerTelemetryHealth.writeFailures + 1,
        error: error instanceof Error ? error.message : String(error),
      };
      void persistWorkerTelemetryHealth().catch(() => {});
      logger.error('[scan-worker-coordinator] capacity telemetry persistence failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  telemetryWriteQueue = operation;
  return operation;
}

export interface ScanWorkerRequest {
  body: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface ScanWorkerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  jobId?: string;
  deduplicated?: boolean;
}

export interface ScanWorkerHandle {
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal?: string | null) => void): this;
  postMessage(message: unknown): void;
  terminate(): Promise<number> | number;
}

interface ScanWorkerCoordinatorOptions {
  maxConcurrent?: number;
  timeoutMs?: number;
  createWorker?: () => ScanWorkerHandle;
  now?: () => number;
  persistTelemetry?: (records: RateLimiterMetricRecord[]) => Promise<void>;
}

interface ActiveJob {
  id: string;
  key: string;
  worker: ScanWorkerHandle;
  startedAt: number;
  subscribers: Set<Subscriber>;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface Subscriber {
  resolve: (response: ScanWorkerResponse) => void;
  reject: (error: ScanWorkerError) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

export class ScanWorkerError extends Error {
  constructor(
    message: string,
    public readonly code: 'SCAN_CAPACITY' | 'SCAN_TIMEOUT' | 'SCAN_CANCELLED' | 'SCAN_WORKER_FAILED',
  ) {
    super(message);
    this.name = 'ScanWorkerError';
  }
}

export interface ScanWorkerMetrics {
  queueDepth: number;
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
  rejectedJobs: number;
  deduplicatedJobs: number;
  cancelledJobs: number;
  timedOutJobs: number;
  lastDurationMs: number | null;
  maxDurationMs: number;
}

function productionWorker(): ScanWorkerHandle {
  // Build the deployment path at runtime. Treating it as a traced module makes
  // Turbopack try to bundle a generated artifact before build:scan-worker runs.
  const workerPath = process.env.H2H_SCAN_WORKER_PATH
    || [process.cwd(), 'dist', 'full-scan-worker.cjs'].join('/');
  const child: ChildProcess = fork(workerPath, [], {
    cwd: process.cwd(),
    env: { ...process.env, H2H_FULL_SCAN_WORKER: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    serialization: 'advanced',
  });
  return {
    on(event, listener) {
      child.on(event, listener as never);
      return this;
    },
    postMessage(message) {
      child.send(message as Parameters<ChildProcess['send']>[0]);
    },
    async terminate() {
      if (child.exitCode != null || child.signalCode != null) return child.exitCode ?? 0;
      child.kill('SIGTERM');
      return 0;
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

export class ScanWorkerCoordinator {
  private readonly active = new Map<string, ActiveJob>();
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly createWorker: () => ScanWorkerHandle;
  private readonly now: () => number;
  private readonly persistTelemetry: (records: RateLimiterMetricRecord[]) => Promise<void>;
  private metrics: ScanWorkerMetrics = {
    queueDepth: 0,
    activeJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    rejectedJobs: 0,
    deduplicatedJobs: 0,
    cancelledJobs: 0,
    timedOutJobs: 0,
    lastDurationMs: null,
    maxDurationMs: 0,
  };

  constructor(options: ScanWorkerCoordinatorOptions = {}) {
    this.maxConcurrent = positiveInteger(options.maxConcurrent, 1);
    this.timeoutMs = positiveInteger(options.timeoutMs, 60_000);
    this.createWorker = options.createWorker ?? productionWorker;
    this.now = options.now ?? Date.now;
    this.persistTelemetry = options.persistTelemetry ?? persistRateLimiterMetrics;
  }

  run(key: string, request: ScanWorkerRequest, signal?: AbortSignal): Promise<ScanWorkerResponse> {
    const existing = this.active.get(key);
    if (existing) {
      this.metrics.deduplicatedJobs += 1;
      return this.subscribe(existing, signal, true);
    }
    if (this.active.size >= this.maxConcurrent) {
      this.metrics.rejectedJobs += 1;
      return Promise.reject(new ScanWorkerError('Scanner is at capacity', 'SCAN_CAPACITY'));
    }

    const worker = this.createWorker();
    const id = randomUUID();
    const job: ActiveJob = {
      id,
      key,
      worker,
      startedAt: this.now(),
      subscribers: new Set(),
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      settled: false,
    };
    this.active.set(key, job);
    this.metrics.activeJobs = this.active.size;

    worker.on('message', (message) => {
      const envelope = message as {
        type?: string;
        response?: ScanWorkerResponse;
        error?: string;
        telemetry?: RateLimiterMetricRecord[];
      };
      if (envelope.type === 'result' && envelope.response) {
        void enqueueWorkerTelemetry(envelope.telemetry ?? [], this.persistTelemetry)
          .then(() => this.finish(job, null, envelope.response))
          .catch((error) => this.finish(job, new ScanWorkerError(
            `Worker telemetry persistence failed: ${error instanceof Error ? error.message : String(error)}`,
            'SCAN_WORKER_FAILED',
          )));
      } else if (envelope.type === 'error') {
        this.finish(job, new ScanWorkerError(envelope.error || 'Scan worker failed', 'SCAN_WORKER_FAILED'));
      }
    });
    worker.on('error', (error) => this.finish(job, new ScanWorkerError(error.message, 'SCAN_WORKER_FAILED')));
    worker.on('exit', (code, exitSignal) => {
      if (!job.settled) {
        this.finish(job, new ScanWorkerError(
          `Scan worker exited before publishing (code=${code ?? 'null'}, signal=${exitSignal ?? 'none'})`,
          'SCAN_WORKER_FAILED',
        ));
      }
    });
    job.timer = setTimeout(() => {
      this.metrics.timedOutJobs += 1;
      this.finish(job, new ScanWorkerError(`Scan exceeded ${this.timeoutMs}ms worker deadline`, 'SCAN_TIMEOUT'));
    }, this.timeoutMs);
    worker.postMessage({ type: 'run', jobId: id, request });
    return this.subscribe(job, signal, false);
  }

  snapshot(): ScanWorkerMetrics {
    return { ...this.metrics, queueDepth: 0, activeJobs: this.active.size };
  }

  private subscribe(job: ActiveJob, signal: AbortSignal | undefined, deduplicated: boolean): Promise<ScanWorkerResponse> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ScanWorkerError('Scan request was cancelled', 'SCAN_CANCELLED'));
        return;
      }
      const subscriber: Subscriber = {
        signal,
        resolve: (response) => resolve({ ...response, jobId: job.id, deduplicated }),
        reject,
      };
      if (signal) {
        subscriber.abort = () => {
          if (!job.subscribers.delete(subscriber)) return;
          signal.removeEventListener('abort', subscriber.abort!);
          this.metrics.cancelledJobs += 1;
          reject(new ScanWorkerError('Scan request was cancelled', 'SCAN_CANCELLED'));
          if (job.subscribers.size === 0 && !job.settled) {
            this.finish(job, null);
          }
        };
        signal.addEventListener('abort', subscriber.abort, { once: true });
      }
      job.subscribers.add(subscriber);
    });
  }

  private finish(job: ActiveJob, error: ScanWorkerError | null, response?: ScanWorkerResponse): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    this.active.delete(job.key);
    const duration = Math.max(0, this.now() - job.startedAt);
    this.metrics.lastDurationMs = duration;
    this.metrics.maxDurationMs = Math.max(this.metrics.maxDurationMs, duration);
    if (error) this.metrics.failedJobs += 1;
    else if (response) this.metrics.completedJobs += 1;
    this.metrics.activeJobs = this.active.size;

    // Every production worker is disposable. Explicitly terminate after a
    // result/error as a backstop so open database handles cannot keep an IPC
    // child alive after its one scan has published.
    void job.worker.terminate();

    for (const subscriber of job.subscribers) {
      if (subscriber.abort && subscriber.signal) subscriber.signal.removeEventListener('abort', subscriber.abort);
      if (error) subscriber.reject(error);
      else if (response) subscriber.resolve(response);
    }
    job.subscribers.clear();
  }
}

export const scanWorkerCoordinator = new ScanWorkerCoordinator({
  maxConcurrent: positiveInteger(Number(process.env.H2H_SCAN_CONCURRENCY), 1),
  timeoutMs: positiveInteger(Number(process.env.H2H_SCAN_WORKER_TIMEOUT_MS), 55_000),
});

export function getScanWorkerMetrics(): ScanWorkerMetrics {
  return scanWorkerCoordinator.snapshot();
}
