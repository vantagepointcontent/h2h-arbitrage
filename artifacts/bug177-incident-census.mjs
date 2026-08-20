import { readFile, writeFile } from 'node:fs/promises';
const all = JSON.parse(await readFile('artifacts/bug177-incident-api-all.json', 'utf8'));
const positive = JSON.parse(await readFile('artifacts/bug177-incident-api-positive.json', 'utf8'));
const defaultDateAll = JSON.parse(await readFile('artifacts/bug177-incident-api-default-date-all.json', 'utf8'));
const report = {
  at: new Date().toISOString(),
  canonicalApi: { total: all.total, returned: all.logs.length, nextCursor: all.nextCursor, summary: all.summary },
  positiveFilterApi: { total: positive.total, returned: positive.logs.length, nextCursor: positive.nextCursor, summary: positive.summary },
  defaultDateAll: { total: defaultDateAll.total, returned: defaultDateAll.logs.length, summary: defaultDateAll.summary },
  firstId: all.logs[0]?.id, lastFirstPageId: all.logs.at(-1)?.id,
};
await writeFile('artifacts/bug177-incident-census.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
