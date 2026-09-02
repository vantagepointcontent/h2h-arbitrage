import { createHash } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';

const paths = [
  'data/saved-markets.json',
  'data/saved-markets.json.bak',
  'data/manual-matches.json',
  'data/predictionhunt-markets.json',
];
const snapshots = paths.map((path) => {
  const bytes = fs.readFileSync(path);
  const value = JSON.parse(bytes.toString('utf8'));
  const rows = Array.isArray(value) ? value : [];
  const ids = rows.map((row) => row?.id).filter((id) => typeof id === 'string' && id.length > 0);
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    count: rows.length,
    duplicateIds: ids.length - new Set(ids).size,
    malformedIds: rows.length - ids.length,
  };
});
const primary = snapshots[0];
const backup = snapshots[1];
const passed = snapshots.every((snapshot) => snapshot.duplicateIds === 0)
  && primary.count === backup.count
  && primary.sha256 === backup.sha256;
const report = {
  checkedAt: new Date().toISOString(),
  passed,
  primaryBackupByteIdentical: primary.sha256 === backup.sha256,
  snapshots,
};
fs.writeFileSync('artifacts/bug864-data-integrity.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (!passed) process.exitCode = 1;
