#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const baselinePath = path.join(repo, 'eslint-baseline.json');
const update = process.argv.includes('--update');

const localEslint = path.join(repo, 'node_modules', '.bin', 'eslint');
const commonGitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
const sharedEslint = path.join(path.dirname(commonGitDir), 'node_modules', '.bin', 'eslint');
const eslintBin = fs.existsSync(localEslint) ? localEslint : sharedEslint;
const run = spawnSync(eslintBin, ['.', '--format', 'json'], {
  cwd: repo,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (run.error) throw run.error;
let results;
try {
  results = JSON.parse(run.stdout || '[]');
} catch {
  process.stderr.write(run.stderr || run.stdout || 'ESLint produced invalid JSON\n');
  process.exit(2);
}

const counts = {};
for (const result of results) {
  const file = path.relative(repo, result.filePath).replaceAll(path.sep, '/');
  for (const finding of result.messages || []) {
    if (finding.severity < 2) continue;
    const key = JSON.stringify([file, finding.ruleId || 'fatal', finding.message]);
    counts[key] = (counts[key] || 0) + 1;
  }
}

if (update) {
  const payload = {
    version: 1,
    generatedBy: 'node scripts/lint-baseline.mjs --update',
    errors: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Recorded ${Object.values(counts).reduce((a, b) => a + b, 0)} existing lint errors in eslint-baseline.json`);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error('Missing eslint-baseline.json; a reviewed baseline must be committed first.');
  process.exit(2);
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).errors || {};
const regressions = [];
for (const [key, count] of Object.entries(counts)) {
  const allowed = Number(baseline[key] || 0);
  if (count > allowed) regressions.push({ finding: JSON.parse(key), count, allowed });
}
if (regressions.length) {
  console.error(`Lint regression: ${regressions.length} finding group(s) exceed the reviewed baseline.`);
  for (const item of regressions.slice(0, 50)) {
    console.error(`${item.finding[0]}: ${item.finding[1]} (${item.count} > ${item.allowed}) ${item.finding[2]}`);
  }
  process.exit(1);
}
const current = Object.values(counts).reduce((a, b) => a + b, 0);
const allowed = Object.values(baseline).reduce((a, b) => a + Number(b), 0);
console.log(`Lint gate passed: ${current}/${allowed} reviewed baseline errors; no new lint errors.`);
