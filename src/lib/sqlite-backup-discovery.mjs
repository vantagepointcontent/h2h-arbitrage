import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function findLatestSqliteBackup(repoRoot) {
  const backupRoots = [
    path.join(repoRoot, 'backups'),
    path.join(repoRoot, 'data', 'backups'),
  ];
  const candidates = [];

  for (const backupRoot of backupRoots) {
    let entries;
    try {
      entries = await readdir(backupRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('edgefinder-') || !entry.name.endsWith('.db')) continue;
      const backupPath = path.join(backupRoot, entry.name);
      candidates.push({
        name: entry.name,
        path: backupPath,
        modifiedAtMs: (await stat(backupPath)).mtimeMs,
      });
    }
  }

  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || right.path.localeCompare(left.path));
  return candidates[0] ?? null;
}