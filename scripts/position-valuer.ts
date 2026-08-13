// Position Valuer — executable-depth valuation and settlement polling for BotTrader positions.
// Built as the standalone PM2 h2h-valuer process. All ledger writes delegate to
// the canonical implementation so freshness clearing, response-time provenance,
// full-depth fee-net valuation, and terminal evidence remain atomic and identical
// to the API/poller path.

import { pollOpenBotPositions } from '../src/lib/bot-positions';

const POLL_INTERVAL_MS = 2 * 60 * 1000;

async function valuateOnce(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] Starting BotTrader position valuation cycle...`);
  const result = await pollOpenBotPositions();
  console.log(`[${new Date().toISOString()}] Valuation complete — updated:${result.updated} settled:${result.settled} errors:${result.errors.length}`);
  for (const error of result.errors) {
    console.error(`[${new Date().toISOString()}] Position ${error.id} unavailable: ${error.error}`);
  }
}

async function run(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Position valuer started — interval: ${POLL_INTERVAL_MS / 1000}s`);
  while (true) {
    const started = Date.now();
    try {
      await valuateOnce();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Valuation cycle failed:`, error instanceof Error ? error.message : String(error));
    }
    const sleepMs = Math.max(1000, POLL_INTERVAL_MS - (Date.now() - started));
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

void run();
