// DATA-001: Category backfill — normalize + infer categories for saved markets.
// Writes directly to SQLite (source of truth post-OPS-009), then refreshes the
// JSON mirror by touching the API? No — direct DB + manual mirror is fine here
// since this is a one-off maintenance script run while the app owns the DB
// (libsql handles concurrent access; writes are row-level updates).
//
// Usage: node scripts/data001-category-backfill.mjs [--dry-run]
import { createClient } from '@libsql/client';
import path from 'path';

const DRY = process.argv.includes('--dry-run');
const db = createClient({ url: `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}` });

// Normalize legacy variants to canonical categories
const NORMALIZE = new Map([
  ['political', 'Politics'],
  ['election', 'Politics'],
  ['general', null], // meaningless — re-infer
]);

// Keyword rules (checked in order, first match wins) — based on actual
// eventTitle patterns in the dataset.
const RULES = [
  [/\b(house|senate|governor|president|election|mayor|primar(y|ies)|congress|parliament|minister|chancellor|nyc.*democratic|electoral|nobel peace|de facto leader)\b/i, 'Politics'],
  [/\b(temperature|high temp|low temp|rain|snow|weather|hurricane|storm|hottest year)\b/i, 'Temperature'],
  [/\b(fed|rate|inflation|cpi|gdp|s&p|nasdaq|bitcoin|btc|eth(ereum)?|crypto|stock|recession|treasury|unemployment|ipo|bank|trillionaire|price)\b/i, 'Finances'],
  [/\b(mention|say|tweet|post)s?\b/i, 'Mentions'],
  [/\b(nfl|nba|mlb|nhl|mls|super bowl|world cup|premier league|ufc|f1|grand prix|olympics|champion|playoff|finals|game|match|cup winner|vs\.?)\b/i, 'Sports'],
  [/\b(oscar|grammy|emmy|album|movie|box office|spotify|billboard|artist|song|person of the year|time person)\b/i, 'Entertainment'],
  [/\b(war|ceasefire|nato|un |united nations|treaty|nuclear|invasion)\b/i, 'World'],
  [/\b(openai|coding ai|ai model|gpt|llm|chatgpt)\b/i, 'Tech'],
];

function inferCategory(title) {
  for (const [re, cat] of RULES) {
    if (re.test(title)) return cat;
  }
  return null;
}

const rows = (await db.execute(
  `SELECT id, event_title, category FROM saved_markets`
)).rows;

let normalized = 0, inferred = 0, unresolved = [];
for (const r of rows) {
  const cur = r.category ? String(r.category).trim() : '';
  const title = String(r.event_title ?? '');
  let next = cur;

  // 1. Normalize legacy variants
  if (NORMALIZE.has(cur.toLowerCase())) {
    next = NORMALIZE.get(cur.toLowerCase()) ?? '';
  }

  // 2. Infer when empty
  if (!next) {
    const guess = inferCategory(title);
    if (guess) { next = guess; inferred++; }
  } else if (next !== cur) {
    normalized++;
  }

  if (next && next !== cur) {
    if (!DRY) {
      await db.execute({
        sql: 'UPDATE saved_markets SET category = ? WHERE id = ?',
        args: [next, r.id],
      });
    }
    console.log(`${DRY ? '[dry] ' : ''}${String(r.id).slice(0, 20)} "${title.slice(0, 50)}" : "${cur}" -> "${next}"`);
  } else if (!next) {
    unresolved.push(title.slice(0, 60));
  }
}

console.log(`\nDone. normalized=${normalized} inferred=${inferred} unresolved=${unresolved.length}${DRY ? ' (DRY RUN — nothing written)' : ''}`);
if (unresolved.length > 0) {
  console.log('\nUnresolved (left uncategorized):');
  for (const t of unresolved.slice(0, 20)) console.log(' -', t);
}
