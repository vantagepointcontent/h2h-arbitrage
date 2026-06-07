const key = 'KEY_HERE';

async function testMatch() {
  const res = await fetch('https://www.predictionhunt.com/api/v2/matching-markets?q=trump&limit=5', {
    headers: { 'Accept': 'application/json', 'X-API-Key': key }
  });
  return { status: res.status, data: await res.json() };
}

async function testMarkets() {
  const res = await fetch('https://www.predictionhunt.com/api/v2/markets?platform=polymarket&status=active&limit=5', {
    headers: { 'Accept': 'application/json', 'X-API-Key': key }
  });
  return { status: res.status, data: await res.json() };
}

(async () => {
  try {
    const m1 = await testMatch();
    console.log('matching-markets:', m1.status, 'success:', m1.data.success, 'events:', m1.data.events?.length || 0);
    
    const m2 = await testMarkets();
    console.log('markets:', m2.status, 'success:', m2.data.success, 'markets:', m2.data.markets?.length || 0, 'total:', m2.data.total_count || 'N/A');
  } catch (e) {
    console.error(e);
  }
})();
