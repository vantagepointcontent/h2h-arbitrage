const fs = require('fs');

// Check related events
const events = JSON.parse(fs.readFileSync('/tmp/pm-fra-mar-all.json', 'utf8'));
console.log('=== Events containing "fifwc-fra-mar" ===');
console.log('Count:', events.length);
for (const e of events) {
  console.log(`  ${e.id}: ${e.title} (slug: ${e.slug}, markets: ${(e.markets||[]).length})`);
}

// Check related markets
const markets = JSON.parse(fs.readFileSync('/tmp/pm-fra-mar-markets.json', 'utf8'));
console.log('\n=== Markets containing "fifwc-fra-mar" ===');
console.log('Count:', markets.length);
for (const m of markets) {
  console.log(`  ${m.question?.slice(0,60)}`);
  console.log(`    groupItemTitle: "${m.groupItemTitle}", slug: ${m.slug}`);
  console.log(`    conditionId: ${m.conditionId?.slice(0,20)}`);
  console.log();
}