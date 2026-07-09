const { createClient } = require('@libsql/client');
const path = require('path');

const db = createClient({ url: `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}` });

async function main() {
  // Check for saved markets with advances/France/Morocco
  const rs = await db.execute({
    sql: `SELECT id, event_title, polymarket_url, kalshi_url 
          FROM saved_markets 
          WHERE polymarket_url LIKE '%advance%' 
             OR event_title LIKE '%advance%' 
             OR event_title LIKE '%France%' 
             OR event_title LIKE '%Morocco%'
          LIMIT 10`,
  });
  console.log('Matching saved markets:');
  for (const row of rs.rows) {
    console.log(`  ${row.id}: ${row.event_title}`);
    console.log(`    PM: ${row.polymarket_url}`);
    console.log(`    Kalshi: ${row.kalshi_url}`);
    console.log();
  }

  // Also show all recent saved markets
  const rs2 = await db.execute({
    sql: `SELECT id, event_title, polymarket_url 
          FROM saved_markets 
          ORDER BY created_at DESC 
          LIMIT 20`,
  });
  console.log('\nAll recent saved markets:');
  for (const row of rs2.rows) {
    console.log(`  ${row.id}: ${row.event_title} → ${row.polymarket_url}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });