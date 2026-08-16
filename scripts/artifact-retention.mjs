#!/usr/bin/env node
import { access, appendFile, lstat, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planArtifactRetention } from '../src/lib/artifact-retention.mjs';

async function appendBounded(file, row) {
  try {
    if ((await stat(file)).size >= 1_000_000) {
      await rm(`${file}.1`, { force: true });
      await rename(file, `${file}.1`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o640 });
}

export async function enforceArtifactRetention(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const artifactRoot = path.join(root, 'artifacts');
  const entries = (await readdir(artifactRoot)).filter((name) => !name.endsWith('.delivered'));
  const candidates = await Promise.all(entries.map(async (name) => {
    let delivered = false;
    try { await access(path.join(artifactRoot, `${name}.delivered`)); delivered = true; } catch {}
    return { name, path: path.join(artifactRoot, name), modifiedAtMs: (await lstat(path.join(artifactRoot, name))).mtimeMs, delivered };
  }));
  const plan = planArtifactRetention(candidates, { maxAgeMs: (options.maxAgeDays ?? 30) * 86_400_000 });
  const events = [];
  for (const candidate of plan.delete) {
    const action = options.live ? 'deleted' : 'would-delete';
    if (options.live) {
      await rm(candidate.path, { recursive: true, force: false });
      await rm(`${candidate.path}.delivered`, { force: true });
    }
    events.push({ action, path: candidate.path });
  }
  const result = { at: new Date().toISOString(), mode: options.live ? 'live' : 'dry-run', events, undeliveredPreserved: plan.keep.filter((item) => !item.delivered).length };
  await appendBounded(path.join(root, 'data', 'artifact-retention-metrics.jsonl'), result);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  enforceArtifactRetention({ live: process.argv.includes('--live') })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
