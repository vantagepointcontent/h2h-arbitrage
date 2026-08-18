import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  appendFile: vi.fn(),
  access: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
  execFile: vi.fn(),
  readDiskCapacitySnapshot: vi.fn(),
  evaluateDiskCapacity: vi.fn(),
  enforceBackupRetention: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  access: mocks.access,
  appendFile: mocks.appendFile,
  readFile: mocks.readFile,
  rename: mocks.rename,
  writeFile: mocks.writeFile,
}));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../../scripts/backup-retention.mjs', () => ({ enforceBackupRetention: mocks.enforceBackupRetention }));
vi.mock('./disk-capacity.mjs', () => ({
  readDiskCapacitySnapshot: mocks.readDiskCapacitySnapshot,
  evaluateDiskCapacity: mocks.evaluateDiskCapacity,
}));

import { inspectSavedMarketScanner } from '../../scripts/scan-supervisor.mjs';

const now = Date.parse('2026-08-18T16:30:00.000Z');

function source(file: string): string {
  if (file.endsWith('release-manifest.json')) return JSON.stringify({ commit: 'abc', buildId: 'build-1' });
  if (file.endsWith('poller-health.json')) return JSON.stringify({
    pollerPid: 42,
    schedulerVersion: 'bug-165-v1',
    heartbeatAt: '2026-08-18T16:29:55.000Z',
    successCount: 3,
    failureCount: 0,
    openBreakers: 0,
    queue: { eligibleCount: 1, dueCount: 0, overdueCount: 0, failedCount: 0, oldestSuccessAgeMs: 1_000 },
  });
  if (file.endsWith('scan-worker-telemetry-health.json')) return JSON.stringify({
    lastReceivedAt: '2026-08-18T16:29:50.000Z',
    pendingSnapshots: 0,
    error: null,
  });
  if (file.endsWith('saved-market-scheduler.json')) return JSON.stringify({ market: {
    lastAttemptAt: '2026-08-18T16:29:45.000Z',
    lastSuccessAt: '2026-08-18T16:29:50.000Z',
    inProgress: false,
  } });
  if (file.endsWith('saved-markets.json')) return '[]';
  throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
}

describe('saved-market scan supervisor runtime inspection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFile.mockImplementation(async (file: string) => source(String(file)));
    mocks.access.mockResolvedValue(undefined);
    mocks.appendFile.mockResolvedValue(undefined);
    mocks.rename.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.readDiskCapacitySnapshot.mockResolvedValue({ freeBytes: 25_000_000_000 });
    mocks.evaluateDiskCapacity.mockReturnValue({ allowed: true, reason: null });
  });

  it('feeds live API SQLite contention metrics through inspectSavedMarketScanner', async () => {
    const result = await inspectSavedMarketScanner({
      now,
      healthSnapshot: {
        sqliteContention: { busyRetries: 0, exhaustedWrites: 0, lastBusyAt: null },
        scanWorkers: { sqliteBusyRetries: 12, sqliteExhaustedWrites: 2, sqliteLastBusyAt: '2026-08-18T16:29:40.000Z' },
      },
    });

    expect(result).toMatchObject({
      state: 'degraded',
      degradedReason: 'sqlite_contention',
      detail: '2 SQLite scanner write(s) exhausted retry budget',
    });
  });

  it('reports malformed telemetry JSON as an unusable source instead of healthy', async () => {
    mocks.readFile.mockImplementation(async (file: string) => {
      if (String(file).endsWith('scan-worker-telemetry-health.json')) return '{not-json';
      return source(String(file));
    });

    const result = await inspectSavedMarketScanner({
      now,
      healthSnapshot: { sqliteContention: { exhaustedWrites: 0 } },
    });

    expect(result).toMatchObject({
      state: 'degraded',
      degradedReason: 'telemetry_source_unusable',
    });
    expect(result.detail).toContain('scan-worker-telemetry-health.json');
  });

  it('durably records and delivers a degraded operational alert', async () => {
    const alertSender = vi.fn().mockResolvedValue({ delivered: true, destination: 'telegram' });
    const result = await inspectSavedMarketScanner({
      now,
      healthSnapshot: { sqliteContention: { exhaustedWrites: 2 } },
      alertSender,
    });

    expect(mocks.appendFile).toHaveBeenCalledWith(
      expect.stringContaining('saved-market-scanner-alerts.jsonl'),
      expect.stringContaining('"degradedReason":"sqlite_contention"'),
    );
    expect(alertSender).toHaveBeenCalledWith(expect.objectContaining({
      state: 'degraded',
      degradedReason: 'sqlite_contention',
      owner: expect.objectContaining({ commit: 'abc', buildId: 'build-1' }),
    }));
    expect(result.operationalAlert).toMatchObject({
      durable: true,
      delivered: true,
      destination: 'telegram',
    });
  });
});
