import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const paths = ['data/saved-markets.json', 'data/saved-markets.json.bak'];
const snapshots = paths.map((relativePath) => {
  const bytes = fs.readFileSync(`${repoRoot}${relativePath}`);
  const rows = JSON.parse(bytes.toString('utf8'));
  const ids = rows.map((row) => row.id);
  return {
    path: relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    count: rows.length,
    uniqueIds: new Set(ids).size,
    duplicateIds: ids.length - new Set(ids).size,
    missingIds: ids.filter((id) => typeof id !== 'string' || id.length === 0).length,
  };
});

const db = createClient({ url: `file:${repoRoot}data/edgefinder.db` });
try {
  const [quickCheck, foreignKeys] = await Promise.all([
    db.execute('PRAGMA quick_check'),
    db.execute('PRAGMA foreign_key_check'),
  ]);
  const report = {
    checkedAt: new Date().toISOString(),
    snapshots,
    byteIdentical: snapshots[0].sha256 === snapshots[1].sha256,
    sqlite: {
      quickCheck: quickCheck.rows.map((row) => Object.values(row)[0]),
      foreignKeyViolations: foreignKeys.rows.length,
    },
  };
  const passed = snapshots.every((snapshot) => snapshot.duplicateIds === 0 && snapshot.missingIds === 0)
    && snapshots[0].count === snapshots[1].count
    && report.byteIdentical
    && report.sqlite.quickCheck.length === 1
    && report.sqlite.quickCheck[0] === 'ok'
    && report.sqlite.foreignKeyViolations === 0;
  fs.writeFileSync('artifacts/bug862-data-integrity.json', `${JSON.stringify({ passed, ...report }, null, 2)}\n`);
  console.log(JSON.stringify({ passed, ...report }));
  if (!passed) process.exitCode = 1;
} finally {
  db.close();
}
