import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(`src/app/components/${name}`, 'utf8');

describe('UI-040 explanatory tooltips', () => {
  it('covers opportunity, timing, dashboard, BotTrader, trades, and open-position headers', () => {
    const opportunity = read('opportunities/OpportunityQueue.tsx');
    expect(opportunity).toContain('Expected profit after deducting trading fees from both platforms');
    expect(opportunity).toContain('Maximum stake fillable at current orderbook depth');

    const timing = read('ArbTimingPanel.tsx');
    expect(timing).toContain('Time period to analyze for arbitrage patterns');
    expect(timing).toContain('Distinct arb opportunities that lasted more than 30 seconds');

    const dashboard = read('DashboardPanel.tsx');
    expect(dashboard).toContain('Average ROI percentage across all arbs found, net of fees');
    expect(dashboard).toContain('Write-Ahead Log size');

    const bot = read('BotTraderPanel.tsx');
    expect(bot).toContain('Total dollars spent on both legs');
    expect(bot).toContain('Unrealized return as a percentage');

    const trades = read('TradesPanel.tsx');
    expect(trades).toContain('Realized profit or loss after all trading fees');
    expect(trades).toContain('Execution state: filled, pending, cancelled, or failed');

    const positions = read('OpenPositionsPanel.tsx');
    expect(positions).toContain('Unrealized profit or loss after estimated exit fees');
    expect(positions).toContain('Available orderbook liquidity for closing the position');
  });
});
