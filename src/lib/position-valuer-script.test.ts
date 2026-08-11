import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('position valuer accounting contract', () => {
  const source = readFileSync('scripts/position-valuer.ts', 'utf8');

  it('keeps open executable P/L fee-net', () => {
    expect(source).toContain('currentValue - pos.total_cost - pos.fees');
  });

  it('retains final settlement value for completed trade display', () => {
    expect(source).toContain('current_value = ?');
    expect(source).toContain('args: [now, side, realizedPnl, payout, now, positionId]');
  });
});
