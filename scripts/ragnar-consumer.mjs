import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = process.env.H2H_BASE_URL || 'http://localhost:3000';
const INTERVAL_MS = Math.max(1_000, Number(process.env.H2H_RAGNAR_INTERVAL_MS || 10_000));
const HEALTH_FILE = process.env.H2H_RAGNAR_HEALTH_FILE || path.join(process.cwd(), 'data', 'ragnar-consumer-health.json');
let stopping = false;
let timer;

async function priorHealth() {
  try { return JSON.parse(await readFile(HEALTH_FILE, 'utf8')); } catch { return {}; }
}

async function writeHealth(update) {
  const previous = await priorHealth();
  const next = { ...previous, ...update, pid: process.pid };
  await mkdir(path.dirname(HEALTH_FILE), { recursive: true });
  const temporary = `${HEALTH_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, HEALTH_FILE);
}

async function consume() {
  const attemptedAt = new Date().toISOString();
  try {
    const response = await fetch(`${BASE_URL}/api/bot-trader/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.H2H_API_TOKEN ? { 'x-h2h-token': process.env.H2H_API_TOKEN } : {}),
      },
      body: JSON.stringify({ catchUp: true, limit: 100 }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error || 'catch-up failed'}`);
    await writeHealth({
      state: 'healthy', attemptedAt, lastSuccessAt: new Date().toISOString(),
      processed: Number(body.processed || 0), byState: body.byState || {}, error: null,
    });
    if (Number(body.processed || 0) > 0) {
      console.log(`[ragnar] consumed ${body.processed} persisted scan(s)`, body.byState || {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeHealth({ state: 'degraded', attemptedAt, error: message }).catch(() => {});
    console.error('[ragnar] catch-up failed:', message);
  }
}

async function tick() {
  if (stopping) return;
  await consume();
  if (!stopping) timer = setTimeout(tick, INTERVAL_MS);
}

function stop() {
  stopping = true;
  clearTimeout(timer);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await tick();
