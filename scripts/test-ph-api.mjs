const API_KEY = 'pmx_X-udqP9vxvMSwLZT_onm3nWTB0uajCn7qHjqrbhblkU';

async function fetchAll(platform) {
  const base = new URL('https://www.predictionhunt.com/api/v2/markets');
  base.searchParams.set('platform', platform);
  base.searchParams.set('status', 'active');
  base.searchParams.set('limit', '5'); // small limit for test
  
  const res = await fetch(base.toString(), {
    headers: { 'Accept': 'application/json', 'X-API-Key': API_KEY }
  });
  const text = await res.text();
  return JSON.parse(text);
}

const pmData = await fetchAll('polymarket');
console.log('Polymarket:', pmData.success, pmData.markets?.length, 'total:', pmData.total_count ?? 'N/A');
if (pmData.markets?.length) {
  console.log('First:', JSON.stringify(pmData.markets[0], null, 2).slice(0, 500));
}

const kData = await fetchAll('kalshi');
console.log('Kalshi:', kData.success, kData.markets?.length, 'total:', kData.total_count ?? 'N/A');
