const API_KEY='pmx_X-...blkU';
const CATEGORIES = [
  'sports', 'politics', 'election', 'entertainment', 'economics',
  'crypto', 'science', 'technology', 'weather', 'international',
];
const RATE_LIMIT_MS = 600;

async function fetchPlatformMarkets(platform, category) {
  const url = new URL('https://www.predictionhunt.com/api/v2/markets');
  url.searchParams.set('platform', platform);
  url.searchParams.set('status', 'active');
  url.searchParams.set('limit', '500');
  if (category) url.searchParams.set('category', category);

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json', 'X-API-Key': API_KEY },
  });
  if (!res.ok) throw new Error(`${platform}/${category}: ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(`${platform}/${category}: API ${data.error || 'failed'}`);
  return (data.markets || []).map(m => ({
    id: m.id,
    title: m.title,
    platform: m.platform,
    source_url: m.source_url,
    category: m.category || category || 'unknown',
    expiration_date: m.expiration_date,
  }));
}

function normalizeTitle(t) {
  return t.toLowerCase()
    .replace(/[.,/#!$%\^\u0026\*;:{}=\-_`~()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

console.log('Fetching PredictionHunt markets...');
const start = Date.now();

const pmMarkets = [], kMarkets = [];
for (const cat of CATEGORIES) {
  try {
    const [pm, k] = await Promise.all([
      fetchPlatformMarkets('polymarket', cat),
      fetchPlatformMarkets('kalshi', cat),
    ]);
    pmMarkets.push(...pm);
    kMarkets.push(...k);
    console.log(`[OK] ${cat}: PM=${pm.length}, K=${k.length}`);
  } catch (e) {
    console.log(`[FAIL] ${cat}: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
}

// Match by normalized title
const kMap = new Map(kMarkets.map(k => [normalizeTitle(k.title), k]));
let matched = 0;
const seen = new Set();

for (const pm of pmMarkets) {
  const nt = normalizeTitle(pm.title);
  const match = kMap.get(nt);
  if (!match || seen.has(nt)) continue;
  seen.add(nt);
  matched++;
}

console.log('\n=== RESULT ===');
console.log(`Polymarket total: ${pmMarkets.length}`);
console.log(`Kalshi total: ${kMarkets.length}`);
console.log(`Matched (same title): ${matched}`);
console.log(`Time: ${((Date.now()-start)/1000).toFixed(1)}s`);

// Show examples
const examples = [];
for (const pm of pmMarkets.slice(0, 500)) {
  const nt = normalizeTitle(pm.title);
  const match = kMap.get(nt);
  if (match && examples.length < 3) {
    examples.push({ title: pm.title, pmUrl: pm.source_url, kUrl: match.source_url });
  }
}
console.log('\nExamples:');
examples.forEach(e => console.log(' -', e.title.slice(0, 60)));
