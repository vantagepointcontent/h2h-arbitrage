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
});
