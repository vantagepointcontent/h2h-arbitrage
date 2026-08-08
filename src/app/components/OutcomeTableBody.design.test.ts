import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('OutcomeTableBody semantic trading styles', () => {
  it('contains no raw palette colors or sub-10px trading labels', () => {
    const source = readFileSync(`${process.cwd()}/src/app/components/OutcomeTableBody.tsx`, 'utf8');
    expect(source).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(source).not.toMatch(/text-\[(?:8|9)px\]/);
    expect(source).toContain('tabular-nums');
    expect(source).toContain('var(--status-positive)');
    expect(source).toContain('var(--surface-panel)');
  });
});
