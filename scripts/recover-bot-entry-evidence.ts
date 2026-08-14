import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BotEntryRecoveryStore } from '../src/lib/bot-entry-recovery';

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function writeManifest(filePath: string, manifest: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Manifests are audit records: refuse to replace an earlier run.
  await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dbPath = path.resolve(option('--db') ?? process.env.H2H_SQLITE_PATH ?? path.join(process.cwd(), 'data', 'edgefinder.db'));
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const manifestPath = path.resolve(option('--manifest') ?? path.join(process.cwd(), 'artifacts', `bot-entry-recovery-${timestamp}.json`));
  const store = new BotEntryRecoveryStore(`file:${dbPath}`);
  try {
    const audited = await store.audit();
    const manifest = apply ? await store.apply(audited) : audited;
    await writeManifest(manifestPath, {
      operation: apply ? 'apply' : 'audit',
      database: dbPath,
      ...manifest,
    });
    process.stdout.write(`${JSON.stringify({ operation: apply ? 'apply' : 'audit', database: dbPath, manifest: manifestPath, counts: manifest.counts, reconciliation: manifest.reconciliation })}\n`);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
