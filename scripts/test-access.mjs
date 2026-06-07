#!/usr/bin/env node
const key = 'API_KEY_PLACEHOLDER';

async function test(api) {
  const url = `https://www.predictionhunt.com/api/v2/${api}?q=trump&limit=5`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'X-API-Key': key }
  });
  const data = await res.json();
  console.log(`${api}: status=${res.status}, success=${data.success}, markets/events=${data.markets?.length || data.events?.length || 0}`);
}

if (!key.includes('PLACEHOLDER')) {
  (async () => {
    await test('matching-markets');
    await test('markets');
  })();
} else {
  console.log('Replace API_KEY_PLACEHOLDER with real key');
}
