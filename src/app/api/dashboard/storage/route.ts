import { NextResponse } from 'next/server';
import path from 'path';
import { getScanCount, getOldestScan } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { parseRetentionDays } from '@/lib/retention-request';
import {
  getDiskUsage,
  getFileSize,
  getDirectorySize,
} from '@/lib/storage-utils';

/**
 * GET /api/dashboard/storage
 *
 * Returns disk, database, WAL, and data-directory sizes plus scan row
 * metadata. All sizes are returned as raw byte counts so the frontend can
 * render them consistently.
 */
export async function GET() {
  try {
    const dataDir = path.join(process.cwd(), 'data');
    const dbPath = path.join(dataDir, 'edgefinder.db');
    const walPath = `${dbPath}-wal`;

    const retention = parseRetentionDays(process.env.H2H_RETENTION_DAYS ?? null);
    const retentionDays = typeof retention === 'number' ? retention : 30;

    const [disk, dbSize, walSize, dataDirSize, scanRowCount, oldestScan] =
      await Promise.all([
        Promise.resolve(getDiskUsage()),
        getFileSize(dbPath),
        getFileSize(walPath),
        getDirectorySize(dataDir),
        getScanCount(),
        getOldestScan(),
      ]);

    return NextResponse.json(
      {
        diskTotal: disk.total,
        diskUsed: disk.used,
        diskFree: disk.free,
        diskPercent: disk.percent,
        dbSize,
        walSize,
        dataDirSize,
        scanRowCount,
        oldestScan,
        retentionDays,
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        },
      },
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to fetch storage stats') },
      { status: 500 },
    );
  }
}
