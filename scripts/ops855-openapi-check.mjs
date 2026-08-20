import http from 'node:http';

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:3000' + path, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, text: body.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
  });
}

async function run() {
  const openapi = await getJson('/api/arb/openapi.json');
  console.log('openapi status', openapi.status);
  if (openapi.data?.components?.schemas?.BotScanEvaluation) {
    const s = openapi.data.components.schemas.BotScanEvaluation;
    console.log('BotScanEvaluation required count', s.required?.length);
    console.log('status enum', s.properties?.status?.enum);
    console.log('logs items required', openapi.data.paths['/api/logs']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.logs?.items?.required);
  } else {
    console.log('missing BotScanEvaluation');
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
