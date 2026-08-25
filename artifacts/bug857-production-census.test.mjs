import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const workspace = new URL('..', import.meta.url).pathname;

const census = JSON.parse(execFileSync(
  process.execPath,
  ['artifacts/bug857-production-census.mjs'],
  { cwd: workspace, encoding: 'utf8', timeout: 300_000 },
));

function assertReconciled(field) {
  assert.equal(
    field.total,
    field.available + field.notApplicable + field.unavailable + field.otherLegitimateStates,
  );
  assert.equal(field.applicable, field.available + field.unavailable);
}

test('census classifies all confirmed-no-arbitrage historical financial fields as not applicable', () => {
  const fields = census.logsApi.rowFields;
  for (const key of ['scanTimeRoi', 'scanTimeProfit', 'scanTimeApy', 'scanTimeStake']) {
    assertReconciled(fields[key]);
    assert.equal(fields[key].notApplicable, census.scope.apiRowsSampled, key);
    assert.equal(fields[key].unavailable, 0, key);
    assert.deepEqual(fields[key].unavailableReasons, {}, key);
  }
});

test('census row, summary, and export scopes reconcile', () => {
  for (const field of Object.values(census.savedMarketsApi.allRows)) assertReconciled(field);
  assert.equal(census.savedMarketsApi.fullVsBasicCountMatches, true);
  assert.equal(census.logsApi.summary.totalArbs, 0);
  assert.equal(census.logsApi.summary.totalProfit, null);
  assert.equal(census.logsExport.sampledRows, census.scope.apiRowsSampled);
  assert.equal(census.logsExport.hasRequiredReasonColumns, true);
});
