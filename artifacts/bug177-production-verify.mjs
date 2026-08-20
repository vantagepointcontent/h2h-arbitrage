import { writeFile } from 'node:fs/promises';

const base = 'http://localhost:3000';
const logsResponse = await fetch(`${base}/api/logs?positiveArbOnly=true&limit=500`, { cache: 'no-store' });
if (!logsResponse.ok) throw new Error(`logs ${logsResponse.status}`);
const logs = await logsResponse.json();
const healthResponse = await fetch(`${base}/api/health`, { cache: 'no-store' });
if (!healthResponse.ok) throw new Error(`health ${healthResponse.status}`);
const health = await healthResponse.json();
const csvResponse = await fetch(`${base}/api/logs/export?positiveArbOnly=true&limit=500`, { cache: 'no-store' });
if (!csvResponse.ok) throw new Error(`export ${csvResponse.status}`);
const parseCsv = (text) => {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (char !== '\r') cell += char;
  }
  return rows.filter((item) => item.length > 1);
};
const csvRows = parseCsv(await csvResponse.text());
const csvHeader = csvRows[0];
const csvIndex = (name) => csvHeader.indexOf(name);
const exported = csvRows.slice(1);
const available = (field) => logs.logs.filter((row) => row.historical_financials?.fields?.[field]?.status === 'available').length;
const apyEligible = logs.logs.filter((row) => typeof row.days_to_expiry === 'number' && row.days_to_expiry > 0);
const exactCurrent = exported.filter((row) => !row[csvIndex('Current ROI Unavailable Reason')].includes('exact linked event URLs'));
const metric = (numerator, denominator) => ({ numerator, denominator, pct: denominator ? numerator * 100 / denominator : 100 });
const report = {
  verifiedAt: new Date().toISOString(),
  deployment: health.deployment,
  rowsChecked: logs.logs.length,
  availability: {
    roi: metric(available('roiPct'), logs.logs.length),
    profit: metric(available('profitUsd'), logs.logs.length),
    apy: metric(apyEligible.filter((row) => row.historical_financials?.fields?.apyPct?.status === 'available').length, apyEligible.length),
    state: metric(logs.logs.filter((row) => row.scan_status === 'completed').length, logs.logs.length),
    currentRoi: metric(exactCurrent.filter((row) => row[csvIndex('Current ROI %')] !== '').length, exactCurrent.length),
  },
  summary: logs.summary,
  dataQuality: logs.dataQuality,
  healthDataQuality: health.logsDataQuality,
  newest: logs.logs.slice(0, 5).map((row) => ({
    id: row.id, scannedAt: row.scanned_at, positiveArbCount: row.positive_arb_count,
    roi: row.historical_financials?.fields?.roiPct,
    profit: row.historical_financials?.fields?.profitUsd,
    apy: row.historical_financials?.fields?.apyPct,
    state: row.scan_status,
    botTraderEvaluationStatus: row.botTraderEvaluationStatus,
  })),
};
await writeFile('artifacts/bug177-production-verification.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
