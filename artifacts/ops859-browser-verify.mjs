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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
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
const screenshot = async (path) => {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path, Buffer.from(result.data, 'base64'));
};
const setViewport = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 1, mobile,
});
const navigate = async (url, ready) => {
  await send('Page.navigate', { url });
  await waitFor(ready);
  await pause(1500);
};
const logsState = () => evaluate(`(() => {
  const headers = [...document.querySelectorAll('thead th')].map((node) => node.textContent.trim().replace(/\\s+/g, ' '));
  const loaded = [...document.querySelectorAll('*')].map((node) => node.textContent?.trim()).find((text) => /^Loaded [\\d,]+ of [\\d,]+ entries$/.test(text || '')) || null;
  const scanNodes = [...document.querySelectorAll('[aria-label^="Scan status:"]')];
  const botHeader = headers.indexOf('BotTrader Status');
  const scanHeader = headers.findIndex((header) => header.startsWith('Scan Status'));
  return {
    width: innerWidth,
    headers,
    botHeader,
    scanHeader,
    botBeforeScan: botHeader >= 0 && scanHeader > botHeader,
    loaded,
    renderedRows: document.querySelectorAll('table tbody tr').length,
    scanStatusCount: scanNodes.length,
    completedDisclaimsResolution: scanNodes.some((node) => /market may still be open.*does not mean/i.test(node.getAttribute('title') || '')),
    scanHeaderExplanation: document.querySelector('[aria-label="About scan status"]')?.getAttribute('title') || null,
    botTraderDetailsVisible: /Candidates evaluated:.*Eligible:.*Placement attempts:.*Placed:/s.test(document.body.innerText),
    invalidArbVisible: /Invalid arb/i.test(document.body.innerText),
    horizontalTableScrollAvailable: [...document.querySelectorAll('*')].some((node) => node.querySelector?.('table') && node.scrollWidth > node.clientWidth + 10),
  };
})()`);
const scrollLogsBottom = () => evaluate(`(() => {
  const targets = [...document.querySelectorAll('*')].filter((node) => node.querySelector?.('table') && node.scrollHeight > node.clientHeight + 100);
  const target = targets.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
  if (!target) return false;
  target.scrollTop = target.scrollHeight;
  target.dispatchEvent(new Event('scroll', { bubbles: true }));
  return true;
})()`);
const marketsState = () => evaluate(`(() => ({
  width: innerWidth,
  bodyHasMarkets: /Markets/i.test(document.body.innerText),
  savedMarketsHeading: document.body.innerText.split('\\n').find((line) => /^SAVED MARKETS \\(\\d+\\)$/.test(line)) || null,
  tableRows: document.querySelectorAll('table tbody tr').length,
  sidebarRows: document.querySelectorAll('[data-testid="saved-markets-scroll"] > *').length,
  detailProvenanceVisible: document.querySelector('[data-testid="selected-market-apy-provenance"]') !== null,
  apyOnlyVisualRows: [...document.querySelectorAll('table tbody tr')].filter((row) => {
    const text = row.textContent || '';
    return /APY/i.test(text) && /No arb/i.test(text) && /\\+\\d+(?:\\.\\d+)?%/.test(text);
  }).length,
  healthySuccessMessageVisible: /Latest persisted list loaded/i.test(document.body.innerText),
  warningVisible: document.querySelector('[role="alert"].status-warning') !== null,
  errorVisible: document.querySelector('[role="alert"].status-negative') !== null,
}))()`);

await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable')]);
await setViewport(1440, 900, false);
await navigate('http://127.0.0.1:3000/?view=logs', `document.querySelectorAll('table tbody tr').length > 0 && [...document.querySelectorAll('button')].some((button) => /Reset filters/i.test(button.textContent || ''))`);
const desktopLogsInitial = await logsState();
const firstScroll = await scrollLogsBottom();
await pause(5000);
const desktopLogsAfterFirstBottom = await logsState();
const secondScroll = await scrollLogsBottom();
await pause(5000);
const desktopLogsAfterSecondBottom = await logsState();
await screenshot('artifacts/ops859-production-logs-desktop.png');

await navigate('http://127.0.0.1:3000/?view=markets', `document.body.innerText.includes('SAVED MARKETS (476)') && document.querySelectorAll('table tbody tr').length > 0`);
await evaluate(`document.querySelector('table tbody tr')?.click()`);
await pause(2000);
const desktopMarkets = await marketsState();
await screenshot('artifacts/ops859-production-markets-desktop.png');

await setViewport(390, 844, false);
await navigate('http://127.0.0.1:3000/?view=logs', `document.querySelectorAll('table tbody tr').length > 0 && [...document.querySelectorAll('button')].some((button) => /Reset filters/i.test(button.textContent || ''))`);
await setViewport(390, 844, false);
await pause(1000);
const mobileLogs = await logsState();
await screenshot('artifacts/ops859-production-logs-mobile.png');
await navigate('http://127.0.0.1:3000/?view=markets', `document.body.innerText.length > 100 && /Markets/i.test(document.body.innerText)`);
const mobileMarkets = await marketsState();
await screenshot('artifacts/ops859-production-markets-mobile.png');

const loadedNumber = (state) => Number((state.loaded?.split(' ')[1] || '0').replaceAll(',', ''));
const report = {
  verifiedAt: new Date().toISOString(),
  desktop: { logsInitial: desktopLogsInitial, logsAfterFirstBottom: desktopLogsAfterFirstBottom, logsAfterSecondBottom: desktopLogsAfterSecondBottom, firstScroll, secondScroll, markets: desktopMarkets },
  mobile: { logs: mobileLogs, markets: mobileMarkets },
  screenshots: [
    'artifacts/ops859-production-logs-desktop.png',
    'artifacts/ops859-production-markets-desktop.png',
    'artifacts/ops859-production-logs-mobile.png',
    'artifacts/ops859-production-markets-mobile.png',
  ],
};
const assertions = {
  desktopStatusContract: desktopLogsInitial.botBeforeScan && desktopLogsInitial.completedDisclaimsResolution
    && desktopLogsInitial.botTraderDetailsVisible && !desktopLogsInitial.invalidArbVisible,
  desktopBottomReach: firstScroll && secondScroll
    && loadedNumber(desktopLogsAfterFirstBottom) >= loadedNumber(desktopLogsInitial) + 500
    && loadedNumber(desktopLogsAfterSecondBottom) >= loadedNumber(desktopLogsAfterFirstBottom) + 500,
  desktopMarketsPopulated: desktopMarkets.savedMarketsHeading === 'SAVED MARKETS (476)'
    && desktopMarkets.tableRows > 0 && desktopMarkets.sidebarRows > 0 && desktopMarkets.apyOnlyVisualRows === 0,
  mobileStatusContract: mobileLogs.width === 390 && mobileLogs.botBeforeScan
    && mobileLogs.completedDisclaimsResolution && mobileLogs.horizontalTableScrollAvailable && !mobileLogs.invalidArbVisible,
  mobileMarketsPopulated: mobileMarkets.width === 390 && mobileMarkets.bodyHasMarkets
    && mobileMarkets.apyOnlyVisualRows === 0 && !mobileMarkets.errorVisible,
  healthyMarketsNeutral: !desktopMarkets.healthySuccessMessageVisible && !desktopMarkets.warningVisible && !desktopMarkets.errorVisible,
};
report.assertions = assertions;
report.failures = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
await writeFile('artifacts/ops859-browser-verification.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
ws.close();
if (report.failures.length) process.exitCode = 1;
