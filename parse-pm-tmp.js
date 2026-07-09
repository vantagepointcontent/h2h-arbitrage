const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/pm-fra-mar.json', 'utf8'));

console.log('Event title:', data.title);
console.log('Event slug:', data.slug);
console.log('Neg risk:', data.negRisk);
console.log('Neg risk market ID:', data.negRiskMarketID);
console.log('Markets count:', (data.markets || []).length);
console.log();

for (const m of (data.markets || [])) {
  console.log(`  Market: ${m.question}`);
  console.log(`    groupItemTitle: "${m.groupItemTitle}"`);
  console.log(`    slug: ${m.slug}`);
  console.log(`    conditionId: ${m.conditionId?.slice(0, 20)}`);
  console.log(`    outcomes: ${m.outcomes}`);
  console.log(`    outcomePrices: ${m.outcomePrices}`);
  console.log(`    active: ${m.active}, closed: ${m.closed}`);
  console.log(`    bestBid: ${m.bestBid}, bestAsk: ${m.bestAsk}`);
  console.log();
}