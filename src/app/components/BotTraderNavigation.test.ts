import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('BotTrader SPA navigation', () => {
  it('places the BotTrader navigation item immediately after Trades', () => {
    const sidebar = read('src/app/components/MarketSidebar.tsx');
    const trades = sidebar.indexOf('label="Trades"');
    const bot = sidebar.indexOf('label="BotTrader"');
    expect(trades).toBeGreaterThan(-1);
    expect(bot).toBeGreaterThan(trades);
    expect((sidebar.slice(trades, bot).match(/<NavButton/g) ?? [])).toHaveLength(1);
    expect(sidebar).toContain('onGoBotTrader');
  });

  it('supports direct URL, popstate, replaceState navigation, and panel rendering', () => {
    const page = read('src/app/page.tsx');
    expect(page).toContain('| "bottrader"');
    expect(page).toContain('view === "bottrader"');
    expect(page).toContain('viewMode === "bottrader"');
    expect(page).toContain('window.history.replaceState({ view: "bottrader" }, "", "/?view=bottrader")');
    expect(page).toContain('<BotTraderPanel />');
  });
});
