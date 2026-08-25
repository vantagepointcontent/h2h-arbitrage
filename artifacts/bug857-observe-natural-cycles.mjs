import { writeFile } from 'node:fs/promises';

const baseUrl = 'http://127.0.0.1:3000';
const sampleCount = Number(process.env.BUG857_SAMPLE_COUNT ?? 6);
const intervalMs = Number(process.env.BUG857_INTERVAL_MS ?? 60_000);
const output = process.env.BUG857_OBSERVATION_OUTPUT ?? 'artifacts/bug857-natural-cycle-observation.json';
const samples = [];
for (let index = 0; index < sampleCount; index += 1) {
  const response = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Health returned HTTP ${response.status}`);
  const health = await response.json();
  const scanner = health.fullScanHealth ?? {};
  const markets = health.components?.markets ?? scanner.components?.markets ?? {};
  const bot = health.components?.botTrader ?? scanner.components?.botTrader ?? {};
  samples.push({
    at: new Date().toISOString(),
    deployment: health.deployment,
    scannerState: health.components?.scanner?.state ?? scanner.state ?? null,
    completedJobs: health.scanWorkers?.completedJobs ?? null,
    failedJobs: health.scanWorkers?.failedJobs ?? null,
    queueDepth: health.scanWorkers?.queueDepth ?? null,
    activeJobs: health.scanWorkers?.activeJobs ?? null,
    unavailableScanStates: markets.unavailableScanStates ?? null,
    unavailableScanStatesPct: markets.unavailableScanStatesPct ?? null,
    unavailableScanStatesWithoutReason: markets.unavailableScanStatesWithoutReason ?? null,
    zeroCurrentRoi: markets.zeroCurrentRoi ?? null,
    marketsState: markets.state ?? null,
    unavailableRoi: markets.unavailableRoi ?? null,
    unavailableRoiPct: markets.unavailableRoiPct ?? null,
    unavailableRoiWithoutReason: markets.unavailableRoiWithoutReason ?? null,
    unavailableProfit: markets.unavailableProfit ?? null,
    unavailableProfitPct: markets.unavailableProfitPct ?? null,
    unavailableProfitWithoutReason: markets.unavailableProfitWithoutReason ?? null,
    botState: bot.state ?? null,
    botPendingScans: bot.pendingScans ?? null,
    botCursorLag: bot.cursorLag ?? null,
    botLatestCompletedScanId: bot.latestCompletedScanId ?? null,
  });
  if (index < sampleCount - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

const report = {
  observedAt: new Date().toISOString(),
  intervalMs,
  samples,
  invariants: {
    oneDeployment: new Set(samples.map((sample) => `${sample.deployment?.commit}:${sample.deployment?.buildId}`)).size === 1,
    jobsAdvanced: Number(samples.at(-1)?.completedJobs) > Number(samples[0]?.completedJobs),
    unavailableDidNotIncrease: Number(samples.at(-1)?.unavailableScanStates) <= Number(samples[0]?.unavailableScanStates),
    noZeroCurrentRoi: samples.every((sample) => sample.zeroCurrentRoi === 0),
    noUnavailableWithoutReason: samples.every((sample) => sample.unavailableScanStatesWithoutReason === 0),
    marketsStayedHealthy: samples.every((sample) => sample.marketsState === 'healthy'),
    noFieldUnavailableWithoutReason: samples.every((sample) => sample.unavailableRoiWithoutReason === 0
      && sample.unavailableProfitWithoutReason === 0),
    botStayedHealthyAndCaughtUp: samples.every((sample) => sample.botState === 'healthy' && sample.botPendingScans === 0 && sample.botCursorLag === 0),
  },
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (Object.values(report.invariants).some((value) => value !== true)) process.exitCode = 1;
