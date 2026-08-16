import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('operational scan retention wiring', () => {
  it('uses the seven-day zero-arbitrage policy in every scheduled pruning path', async () => {
    const [poller, maintenance, persistence, request, packageText] = await Promise.all([
      readFile(path.join(root, 'scripts', 'poll.mjs'), 'utf8'),
      readFile(path.join(root, 'scripts', 'db-maintenance.mjs'), 'utf8'),
      readFile(path.join(root, 'src', 'lib', 'persistence.ts'), 'utf8'),
      readFile(path.join(root, 'src', 'lib', 'retention-request.ts'), 'utf8'),
      readFile(path.join(root, 'package.json'), 'utf8'),
    ]);

    expect(poller).toContain('/api/prune-scans?days=7');
    expect(maintenance).toContain("from '../src/lib/scan-retention.mjs'");
    expect(maintenance).toContain('scanRetentionDeleteSql');
    expect(persistence).toContain("from './scan-retention.mjs'");
    expect(persistence).toContain('scanRetentionDeleteSql');
    expect(request).toContain('DEFAULT_RETENTION_DAYS = 7');
    expect(JSON.parse(packageText).scripts['build:maintenance']).toContain('esbuild scripts/db-maintenance.mjs --bundle');
  });
});
