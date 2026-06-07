import { runFullSync } from '../src/lib/predictionhunt.js';

console.log('Starting PredictionHunt full sync via /v2/markets...');
const start = Date.now();

try {
  const log = await runFullSync();
  console.log('\n=== RESULT ===');
  console.log('Time:', ((Date.now() - start) / 1000).toFixed(1), 's');
  console.log('Categories:', log.categoriesSucceeded.join(', '));
  console.log('Total fetched:', log.totalFetched);
  console.log('Matched (PM+Kalshi):', log.added + log.duplicates);
  console.log('New added:', log.added);
  console.log('Duplicates:', log.duplicates);
  console.log('Current cache size:', log.currentMarketCount);
  if (log.categoriesFailed.length) {
    console.log('Failed:', log.categoriesFailed.map(f => `${f.category}: ${f.error}`));
  }
} catch (err) {
  console.error('SYNC FAILED:', err);
  process.exit(1);
}
