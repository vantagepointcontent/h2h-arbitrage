import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';

const dbPath = process.env.H2H_SQLITE_PATH || 'data/edgefinder.db';
const client = createClient({ url: `file:${dbPath}` });
try {
  const integrity = await client.execute('PRAGMA integrity_check');
  const foreignKeys = await client.execute('PRAGMA foreign_key_check');
  const dbCounts = await client.execute(`SELECT
    (SELECT COUNT(*) FROM saved_markets) AS saved_markets,
    (SELECT COUNT(*) FROM scan_results) AS scan_results`);
  const files = {};
  for (const path of ['data/saved-markets.json', 'data/saved-markets.json.bak']) {
    const bytes = await readFile(path);
    const parsed = JSON.parse(bytes.toString('utf8'));
    files[path] = {
      validJson: true,
      rows: Array.isArray(parsed) ? parsed.length : null,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  process.stdout.write(`${JSON.stringify({
    observedAt: new Date().toISOString(), dbPath,
    integrity: String(integrity.rows[0]?.integrity_check ?? 'unknown'),
    foreignKeyViolations: foreignKeys.rows.length,
    dbCounts: dbCounts.rows[0], files,
  }, null, 2)}\n`);
} finally {
  client.close();
}
