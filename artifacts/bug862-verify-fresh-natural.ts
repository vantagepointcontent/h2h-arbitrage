import { readFile, writeFile } from 'node:fs/promises';
import { quoteOneShareFromTopAsk } from '../src/lib/executable-book';

async function main() {
const book = JSON.parse(await readFile('artifacts/bug862-fresh-natural-book.json', 'utf8')) as {
  market: string; asset_id: string; timestamp: string;
  asks: Array<{ price: string; size: string }>;
  min_order_size: string; tick_size: string;
};
const validAsks = book.asks.map((level) => ({ price: Number(level.price), size: Number(level.size) }))
  .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0);
const bestAsk = Math.min(...validAsks.map((level) => level.price));
const availableShares = validAsks.filter((level) => level.price === bestAsk).reduce((sum, level) => sum + level.size, 0);
const observedAt = new Date(Number(book.timestamp)).toISOString();
const quote = quoteOneShareFromTopAsk({
  price: bestAsk,
  depthUsd: bestAsk * availableShares,
  tickSize: Number(book.tick_size),
  minimumOrderSize: Number(book.min_order_size),
  depthTimestamp: observedAt,
});
const report = {
  verifiedAt: new Date().toISOString(), conditionId: book.market, tokenId: book.asset_id,
  orderSide: 'BUY', outcomeSide: 'yes', providerHttpStatus: 200,
  rawAskLevelCount: book.asks.length, bestAsk, availableShares, observedAt,
  freshnessMs: Date.now() - Number(book.timestamp), minimumOrderSize: Number(book.min_order_size),
  tickSize: Number(book.tick_size), quote,
  minimumGate: Number(book.min_order_size) > 1
    ? `Polymarket YES minimum order ${book.min_order_size} exceeds canonical executable quantity 1`
    : null,
};
await writeFile('artifacts/bug862-fresh-natural-verification.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
}

void main();
