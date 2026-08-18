import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock('@libsql/client', () => ({
  createClient: mocks.createClient,
}));

describe('coupling store initialization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('does not create or configure a second SQLite client when an executor is supplied', async () => {
    const executor = { execute: vi.fn(async () => ({ rows: [] })) };
    const { ensureCouplingStore } = await import('./coupling-store');

    await ensureCouplingStore(executor);

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(executor.execute).toHaveBeenCalled();
  });

  it('awaits connection-local busy timeout without renegotiating WAL mode', async () => {
    const execute = vi.fn(async (_statement: unknown) => ({ rows: [] }));
    mocks.createClient.mockReturnValue({ execute });
    const { ensureCouplingStore } = await import('./coupling-store');

    await ensureCouplingStore();

    expect(execute.mock.calls[0]?.[0]).toBe('PRAGMA busy_timeout = 5000');
    expect(execute).not.toHaveBeenCalledWith('PRAGMA journal_mode = WAL');
  });

  it('coalesces concurrent schema initialization onto one SQLite sequence', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const execute = vi.fn(async (_statement: unknown) => {
      if (execute.mock.calls.length === 1) await first;
      return { rows: [] };
    });
    mocks.createClient.mockReturnValue({ execute });
    const { ensureCouplingStore } = await import('./coupling-store');

    const left = ensureCouplingStore();
    const right = ensureCouplingStore();
    releaseFirst();
    await Promise.all([left, right]);

    expect(execute.mock.calls.filter(([sql]) => String(sql).startsWith('CREATE TABLE IF NOT EXISTS coupling_states'))).toHaveLength(1);
  });
});
