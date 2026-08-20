import { writeFile } from 'node:fs/promises';
import WebSocket from 'ws';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const target = targets.find((item) => item.type === 'page');
if (!target) throw new Error('CDP page not found');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
let id = 1;
const pending = new Map();
ws.on('message', (payload) => {
  const message = JSON.parse(payload.toString());
  if (!message.id || !pending.has(message.id)) return;
  const waiter = pending.get(message.id); pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = id++; pending.set(requestId, { resolve, reject });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
const evaluate = async (expression, awaitPromise = false) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const waitFor = async (expression, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${expression}`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screenshot = async (path, clip) => {
  const captured = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip } : {}) });
  await writeFile(path, Buffer.from(captured.data, 'base64'));
};

await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable')]);
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:3000/?view=logs' });
await waitFor(`document.querySelectorAll('table tbody tr').length > 0 && document.body.innerText.includes('Avg ROI')`);
await pause(2_000);
const logsState = async () => evaluate(`(() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const body = document.body.innerText;
  const scroller = document.querySelector('[data-testid="logs-table-scroll"]');
  const roiCells = rows.flatMap((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent?.trim() || '')).filter((text) => /%$/.test(text));
  return {
    url: location.href,
    renderedRows: rows.length,
    virtualScrollHeight: scroller?.scrollHeight ?? 0,
    scrollTop: scroller?.scrollTop ?? 0,
    positivePercentCells: roiCells.filter((text) => { const n=Number(text.replace('%','')); return Number.isFinite(n) && n > 0; }).length,
    unavailableCells: rows.filter((row) => /Unavailable|No arb|—/.test(row.textContent || '')).length,
    firstRowText: rows[0]?.textContent?.trim().slice(0, 800) || null,
    summaryText: body.split('\\n').filter((line) => /^(Total Arbs|Avg ROI|Best ROI|Total Profit)$/i.test(line.trim()) || /^(55,|0\.9|25\.3|\$206)/.test(line.trim())).slice(0, 20),
  };
})()`);
const logsInitial = await logsState();
await screenshot('artifacts/ops860-production-logs-1920.png');
const logsRefreshClicked = await evaluate(`(() => { const button=[...document.querySelectorAll('button')].find((node)=>(node.textContent||'').trim()==='Refresh'); if(!button)return false; button.click(); return true; })()`);
await pause(3_000);
const logsAfterRefresh = await logsState();

const clickFirstLog = await evaluate(`(() => { const row=document.querySelector('table tbody tr'); if (!row) return false; row.click(); return true; })()`);
await pause(2_000);
const selectedLog = await evaluate(`(() => {
  const body=document.body.innerText;
  return { clicked:${JSON.stringify(clickFirstLog)}, detailVisible:/Current ROI|Validation|Strategy/.test(body), detailExcerpt:body.split('\\n').filter((line)=>/Current ROI|Historical ROI|Validation|Strategy|Unavailable|No arb/.test(line)).slice(-30) };
})()`);
await evaluate(`document.querySelector('table tbody tr')?.click()`);
await pause(500);

const scrollBottom = () => evaluate(`(() => {
  const target=document.querySelector('[data-testid="logs-table-scroll"]');
  if(!target) return {found:false};
  target.scrollTop=target.scrollHeight; target.dispatchEvent(new Event('scroll',{bubbles:true}));
  return {found:true,clientHeight:target.clientHeight,scrollHeight:target.scrollHeight,scrollTop:target.scrollTop};
})()`);
const firstReach = await scrollBottom(); await pause(5_000); const logsAfterFirstBottom = await logsState();
const secondReach = await scrollBottom(); await pause(5_000); const logsAfterSecondBottom = await logsState();

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await evaluate(`(() => { const scroller=document.querySelector('[data-testid="logs-table-scroll"]'); if(scroller) scroller.scrollTop=0; window.scrollTo(0,0); })()`);
await pause(1_000); await screenshot('artifacts/ops860-production-logs-390.png', { x: 0, y: 0, width: 390, height: 844, scale: 1 });

await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:3000/?view=markets' });
await waitFor(`document.body.innerText.includes('SAVED MARKETS (476)') && document.querySelectorAll('table tbody tr').length > 0`);
await pause(3_000);
const marketsInitial = await evaluate(`(() => {
  const body=document.body.innerText; const rows=[...document.querySelectorAll('table tbody tr')];
  return {
    savedHeading:body.split('\\n').find((line)=>line.startsWith('SAVED MARKETS (')) || null,
    renderedRows:rows.length,
    positivePercentCells:[...document.querySelectorAll('td')].map((cell)=>cell.textContent?.trim()||'').filter((text)=>{if(!/%$/.test(text))return false;const n=Number(text.replace('%',''));return Number.isFinite(n)&&n>0;}).length,
    apyUnavailableVisible:/APY unavailable|Unavailable/.test(body),
    firstRowText:rows[0]?.textContent?.trim().slice(0,800)||null,
  };
})()`);
await screenshot('artifacts/ops860-production-markets-1920.png');
const selectedMarketClick = await evaluate(`(() => { const row=document.querySelector('table tbody tr'); if(!row)return false; row.click(); return true; })()`);
await pause(2_000);
const selectedMarket = await evaluate(`(() => { const body=document.body.innerText; return {clicked:${JSON.stringify(selectedMarketClick)},detailVisible:/Strategy|Current ROI|APY/.test(body),detailExcerpt:body.split('\\n').filter((line)=>/Current ROI|ROI|APY|Strategy|Profit|Unavailable|non-executable/i.test(line)).slice(-40)}; })()`);
const roiSortClicked = await evaluate(`(() => { const button=[...document.querySelectorAll('button')].find((node)=>/^ROI\\s*[↑↓↕]?$/i.test((node.textContent||'').trim())); if(!button)return false; button.click(); return true; })()`);
await pause(2_000);
const sortedMarketFirstRow = await evaluate(`document.querySelector('table tbody tr')?.textContent?.trim().slice(0,800) || null`);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await pause(1_000); await screenshot('artifacts/ops860-production-markets-390.png', { x: 0, y: 0, width: 390, height: 844, scale: 1 });

const report = {
  verifiedAt: new Date().toISOString(),
  logs: { initial: logsInitial, refreshClicked: logsRefreshClicked, afterRefresh: logsAfterRefresh, selectedLog, firstReach, afterFirstBottom: logsAfterFirstBottom, secondReach, afterSecondBottom: logsAfterSecondBottom },
  markets: { initial: marketsInitial, selectedMarket, roiSortClicked, sortedMarketFirstRow },
  assertions: {
    logsPopulated: logsInitial.renderedRows > 0 && logsInitial.positivePercentCells > 0,
    logsRefreshPreservesPopulation: logsRefreshClicked && logsAfterRefresh.renderedRows > 0 && logsAfterRefresh.positivePercentCells > 0,
    logsTruthfulUnavailable: logsInitial.unavailableCells > 0,
    selectedLogDetail: selectedLog.clicked && selectedLog.detailVisible,
    bottomReachLoadsOneBatchEach: firstReach.found && secondReach.found
      && logsAfterFirstBottom.virtualScrollHeight > logsInitial.virtualScrollHeight
      && logsAfterSecondBottom.virtualScrollHeight > logsAfterFirstBottom.virtualScrollHeight,
    marketsPopulated: marketsInitial.savedHeading === 'SAVED MARKETS (476)' && marketsInitial.positivePercentCells > 0,
    selectedMarketDetail: selectedMarket.clicked && selectedMarket.detailVisible,
    roiSortingInteractive: roiSortClicked && Boolean(sortedMarketFirstRow),
  },
};
report.failures = Object.entries(report.assertions).filter(([, passed]) => !passed).map(([name]) => name);
await writeFile('artifacts/ops860-browser-verification.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
ws.close();
if (report.failures.length) process.exitCode = 1;
