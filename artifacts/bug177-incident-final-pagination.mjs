import { readFile, writeFile } from 'node:fs/promises';
const payload = JSON.parse(await readFile('artifacts/bug177-incident-final-first500.json', 'utf8'));
const second = await (await fetch(`http://localhost:3000/api/logs?limit=500&before=${encodeURIComponent(payload.nextCursor)}`)).json();
const firstIds = new Set(payload.logs.map((row) => row.id));
const report = { at: new Date().toISOString(), total: payload.total, returned: payload.logs.length, nextCursor: payload.nextCursor, firstId: payload.logs[0]?.id, lastId: payload.logs.at(-1)?.id, secondPageReturned: second.logs?.length, secondPageNextCursor: second.nextCursor, duplicateIdsAcrossPages: second.logs?.filter((row) => firstIds.has(row.id)).length, summary: payload.summary, dataQualityState: payload.dataQuality?.latest?.state };
await writeFile('artifacts/bug177-incident-final-pagination.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
