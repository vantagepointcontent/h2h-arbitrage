import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('DashboardPanel semantic trading styles', () => {
  it('uses design-system tokens across cards, charts and trading metrics', () => {
    const source = readFileSync(`${process.cwd()}/src/app/components/DashboardPanel.tsx`, 'utf8');
    expect(source).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(source).toContain('var(--surface-panel)');
    expect(source).toContain('var(--status-positive)');
    expect(source).toContain('var(--text-secondary)');
    expect(source).toContain('tabular-nums');
  });
});
