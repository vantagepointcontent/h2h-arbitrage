import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('OpenPositionsPanel trading design system migration', () => {
  it('uses semantic surface/status tokens and shared table/empty-state primitives', () => {
    const source = readFileSync(`${process.cwd()}/src/app/components/OpenPositionsPanel.tsx`, 'utf8');
    expect(source).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(source).toContain('DataTable');
    expect(source).toContain('EmptyState');
    expect(source).toContain('tabular-nums');
    expect(source).not.toContain('text-[9px]');
  });

  it('wires every required sortable column', () => {
    const source = readFileSync(`${process.cwd()}/src/app/components/OpenPositionsPanel.tsx`, 'utf8');
    expect(source).toContain("toggleSort('market')");
    expect(source).toContain("toggleSort('roi')");
    expect(source).toContain("toggleSort('size')");
  });

  it('renders loading and retryable fetch errors before any zero-valued metrics or empty state', () => {
    const source = readFileSync(`${process.cwd()}/src/app/components/OpenPositionsPanel.tsx`, 'utf8');
    expect(source).toContain('if (loading)');
    expect(source).toContain('Failed to load positions');
    expect(source).toContain('onClick={() => void load()}');
    expect(source.indexOf('if (error)')).toBeLessThan(source.indexOf('return (\n    <div className="space-y-4">'));
  });
});
