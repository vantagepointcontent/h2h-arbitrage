import { createClient } from '@libsql/client';
import path from 'path';
import { recoverHistoricalScanFinancials } from '../src/lib/historical-scan-financial-recovery';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const sqlitePath = process.env.H2H_SQLITE_PATH || path.join(process.cwd(), 'data', 'edgefinder.db');
  const client = createClient({ url: `file:${sqlitePath}` });
  try {
    await client.execute('PRAGMA busy_timeout = 5000');
    const report = await recoverHistoricalScanFinancials(client, { apply });
    process.stdout.write(`${JSON.stringify({ sqlitePath, ...report })}\n`);
    if (report.counts.conflicted > 0) process.exitCode = 2;
  } finally {
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Logs financial recovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
