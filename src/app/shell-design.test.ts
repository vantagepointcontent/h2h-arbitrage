import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(`${process.cwd()}/${path}`, 'utf8');

describe('application shell semantic trading styles', () => {
  it.each(['src/app/page.tsx', 'src/app/components/MarketSidebar.tsx'])('%s has no raw palette colors', (path) => {
    const source = read(path);
    expect(source).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(source).toContain('var(--surface-');
    expect(source).toContain('var(--text-');
  });
});
