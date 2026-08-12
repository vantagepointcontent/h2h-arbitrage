const { test, expect } = require('/home/scott/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/test');

test('UI-047 mobile shell', async ({ page }) => {
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:3000/?view=bottrader');
  await page.locator('[aria-label="Performance analytics"]').waitFor();
  const performance = page.locator('[aria-label="Performance analytics"]');
  const pnl = page.locator('[aria-label="P&L summary"]');
  const toolbar = page.getByTestId('positions-toolbar');
  await performance.screenshot({ path: 'runtime-evidence/ui-047/mobile-performance.png' });
  await pnl.screenshot({ path: 'runtime-evidence/ui-047/mobile-pnl.png' });
  await toolbar.screenshot({ path: 'runtime-evidence/ui-047/mobile-positions-toolbar.png' });
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  const roiCard = page.getByRole('listitem', { name: 'roi method performance' });
  const roiLayout = await roiCard.evaluate((element) => ({
    card: element.getBoundingClientRect().toJSON(),
    title: element.firstElementChild.getBoundingClientRect().toJSON(),
    display: getComputedStyle(element).display,
    textAlign: getComputedStyle(element).textAlign,
  }));
  console.log(JSON.stringify({ dimensions, errors, roiLayout }));
  expect(dimensions.page).toBe(dimensions.viewport);
  expect(errors).toEqual([]);
});
