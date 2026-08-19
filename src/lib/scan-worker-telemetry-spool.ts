import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RateLimiterMetricRecord } from './persistence';
import { withSqliteBusyRetry } from './sqlite-write-retry';
import logger from './logger';

export interface WorkerTelemetryWriteHealth {
  lastReceivedAt: string | null;
  lastPersistedAt: string | null;
  lastFailureAt: string | null;
  lastDrainAttemptAt: string | null;
  writeFailures: number;
  pendingSnapshots: number;
  oldestPendingAt: string | null;
  recoveredSnapshots: number;
  error: string | null;
}

interface SpoolEnvelope {
  version: 1;
  id: string;
  receivedAt: string;
  records: RateLimiterMetricRecord[];
}

interface WorkerTelemetrySpoolOptions {
  spoolDir?: string;
  healthPath?: string;
  persist: (records: RateLimiterMetricRecord[]) => Promise<void>;
  now?: () => Date;
  retryDelayMs?: number;
  autoRetry?: boolean;
  autoDrain?: boolean;
}

const EMPTY_HEALTH: WorkerTelemetryWriteHealth = {
  lastReceivedAt: null,
  lastPersistedAt: null,
  lastFailureAt: null,
  lastDrainAttemptAt: null,
  writeFailures: 0,
  pendingSnapshots: 0,
  oldestPendingAt: null,
  recoveredSnapshots: 0,
  error: null,
};

const DRAIN_BATCH_SIZE = 25;

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(tempPath, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tempPath, filePath);
  const directory = await open(path.dirname(filePath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class WorkerTelemetrySpool {
  private readonly spoolDir: string;
  private readonly healthPath: string;
  private readonly persist: (records: RateLimiterMetricRecord[]) => Promise<void>;
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly autoRetry: boolean;
  private readonly autoDrain: boolean;
  private health: WorkerTelemetryWriteHealth = { ...EMPTY_HEALTH };
  private drainPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(options: WorkerTelemetrySpoolOptions) {
    this.spoolDir = options.spoolDir ?? path.join(process.cwd(), 'data', 'scan-worker-telemetry-spool');
    this.healthPath = options.healthPath ?? path.join(process.cwd(), 'data', 'scan-worker-telemetry-health.json');
    this.persist = options.persist;
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = Math.max(100, options.retryDelayMs ?? 5_000);
    this.autoRetry = options.autoRetry ?? true;
    this.autoDrain = options.autoDrain ?? true;
  }

  start(): void {
    void this.ensureLoaded().finally(() => { void this.drain(); });
  }

  async accept(id: string, records: RateLimiterMetricRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.ensureLoaded();
    const receivedAt = this.now().toISOString();
    const envelope: SpoolEnvelope = { version: 1, id, receivedAt, records };
    const target = path.join(this.spoolDir, `${safeId(id)}.json`);
    try {
      await readFile(target, 'utf8');
    } catch {
      await atomicJsonWrite(target, envelope);
    }
    this.health = { ...this.health, lastReceivedAt: receivedAt };
    await this.refreshPendingHealth();
    await this.persistHealth();
    if (this.autoDrain) void this.drain();
  }

  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainOnce().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  async readHealth(): Promise<WorkerTelemetryWriteHealth> {
    await this.ensureLoaded();
    await this.refreshPendingHealth();
    return { ...this.health };
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          this.health = { ...EMPTY_HEALTH, ...JSON.parse(await readFile(this.healthPath, 'utf8')) };
        } catch { /* first start or an interrupted best-effort health write */ }
      })();
    }
    return this.loadPromise;
  }

  private async listEnvelopeFiles(): Promise<string[]> {
    await mkdir(this.spoolDir, { recursive: true });
    return (await readdir(this.spoolDir)).filter((name) => name.endsWith('.json')).sort();
  }

  private async refreshPendingHealth(): Promise<string[]> {
    const files = await this.listEnvelopeFiles();
    let oldestPendingAt: string | null = null;
    if (files[0]) {
      try {
        const envelope = JSON.parse(await readFile(path.join(this.spoolDir, files[0]), 'utf8')) as SpoolEnvelope;
        oldestPendingAt = envelope.receivedAt ?? null;
      } catch { /* drain reports malformed envelopes as failures */ }
    }
    this.health = { ...this.health, pendingSnapshots: files.length, oldestPendingAt };
    return files;
  }

  private async persistHealth(): Promise<void> {
    await atomicJsonWrite(this.healthPath, this.health);
  }

  private async drainOnce(): Promise<void> {
    const files = await this.refreshPendingHealth();
    for (let offset = 0; offset < files.length; offset += DRAIN_BATCH_SIZE) {
      const batch = files.slice(offset, offset + DRAIN_BATCH_SIZE);
      this.health = { ...this.health, lastDrainAttemptAt: this.now().toISOString() };
      try {
        const envelopes = await Promise.all(batch.map(async (fileName) => {
          const envelope = JSON.parse(await readFile(path.join(this.spoolDir, fileName), 'utf8')) as SpoolEnvelope;
          if (envelope.version !== 1 || !Array.isArray(envelope.records)) {
            throw new Error(`Malformed worker telemetry spool envelope: ${fileName}`);
          }
          return envelope;
        }));
        await withSqliteBusyRetry(() => this.persist(envelopes.flatMap((envelope) => envelope.records)));
        for (const fileName of batch) {
          await rm(path.join(this.spoolDir, fileName));
        }
        this.health = {
          ...this.health,
          lastPersistedAt: this.now().toISOString(),
          recoveredSnapshots: this.health.recoveredSnapshots + (this.health.error ? batch.length : 0),
          error: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.health = {
          ...this.health,
          lastFailureAt: this.now().toISOString(),
          writeFailures: this.health.writeFailures + 1,
          error: message,
        };
        logger.error('[scan-worker-telemetry-spool] drain failed; snapshot retained for retry', {
          fileName: batch[0],
          batchSize: batch.length,
          error: message,
        });
        await this.refreshPendingHealth();
        await this.persistHealth();
        this.scheduleRetry();
        return;
      }
      await this.refreshPendingHealth();
      await this.persistHealth();
    }
  }

  private scheduleRetry(): void {
    if (!this.autoRetry || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
  }
}