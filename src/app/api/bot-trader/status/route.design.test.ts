import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('BotTrader status and production safety contracts', () => {
  it('serves live status with settings and real daily counters', () => {
    const route = readFileSync('src/app/api/bot-trader/status/route.ts', 'utf8');
    expect(route).toContain("getSetting<boolean>('bot.enabled')");
    expect(route).toContain("getSetting<string>('bot.mode')");
    expect(route).toContain('getTodayBotExposure()');
    expect(route).toContain("getExecutions(10_000, 'bot')");
    expect(route).toContain("'Cache-Control': 'no-store, no-cache, must-revalidate'");
  });

  it('rejects production mode server-side unless global execution is live', () => {
    const route = readFileSync('src/app/api/settings/route.ts', 'utf8');
    expect(route).toContain("values['bot.mode'] === 'production'");
    expect(route).toContain("getSetting<string>('execute.mode')");
    expect(route).toContain("executeMode !== 'live'");
  });
});
