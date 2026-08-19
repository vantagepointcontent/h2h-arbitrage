import { BotPositionStore } from '../src/lib/bot-positions';

async function main(): Promise<void> {
  const store = new BotPositionStore(process.env.H2H_DB_URL);
  try {
    const report = await store.backfillEntryArbProfitSnapshots();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.conflicted > 0) process.exitCode = 2;
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Entry Arb Profit backfill failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
