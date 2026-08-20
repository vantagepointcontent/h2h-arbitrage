import { readFile } from 'node:fs/promises';

const file = 'data/saved-markets.json';
const id = '4157052a-5b8c-477f-93a0-ef4e8797644d';
const cutoff = Date.parse('2026-08-20T09:35:11.646Z');
const deadline = Date.now() + 12 * 60_000;
while (Date.now() < deadline) {
  try {
    const markets = JSON.parse(await readFile(file, 'utf8'));
    const market = markets.find((item) => item.id === id);
    const scannedAt = market?.lastScanResult?.scannedAt ?? null;
    if (scannedAt && Date.parse(scannedAt) >= cutoff && market.lastScanResult.matchStatus !== 'refreshing') {
      console.log(JSON.stringify({ id, eventTitle: market.eventTitle, scannedAt, matchStatus: market.lastScanResult.matchStatus }));
      process.exit(0);
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
throw new Error('Timed out waiting for the production F1 control scan');
