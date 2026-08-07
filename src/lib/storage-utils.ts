import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';

export interface DiskUsage {
  total: number;
  used: number;
  free: number;
  percent: number;
}

/** Return disk usage for the filesystem that holds the current working directory. */
export function getDiskUsage(): DiskUsage {
  const stats = fsSync.statfsSync(process.cwd());
  const total = Number(stats.blocks) * Number(stats.bsize);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const used = total - free;
  return {
    total,
    used,
    free,
    percent: total > 0 ? Math.round((used / total) * 100) : 0,
  };
}

/** Return the size of a file, or 0 if it does not exist. */
export async function getFileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/** Recursively sum the sizes of all regular files under a directory. */
export async function getDirectorySize(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    let total = 0;
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const parentPath = (entry as any).parentPath ?? (entry as any).path;
        const filePath = path.join(parentPath, entry.name);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isFile()) total += stat.size;
        } catch {
          // ignore files that disappear during traversal
        }
      }),
    );
    return total;
  } catch {
    return 0;
  }
}

/** Human-readable byte string (e.g. 365 MB). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1).replace(/\.0$/, '')} ${units[i]}`;
}
