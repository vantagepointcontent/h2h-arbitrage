import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const page = fs.readFileSync(path.join(process.cwd(), 'src/app/page.tsx'), 'utf8');
const rail = fs.readFileSync(path.join(process.cwd(), 'src/app/components/shell/TradingStatusRail.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.join(process.cwd(), 'src/app/components/MarketSidebar.tsx'), 'utf8');
const dashboard = fs.readFileSync(path.join(process.cwd(), 'src/app/components/DashboardPanel.tsx'), 'utf8');

describe('shared shell responsive overflow', () => {
  it('allows the flex workspace and content pane to shrink inside the viewport', () => {
    expect(page).toContain('h-[100dvh] min-h-0');
    expect(page).toContain('flex min-h-0 min-w-0 flex-1 overflow-hidden');
    expect(page).toContain('min-w-0 flex-1 overflow-x-hidden overflow-y-auto');
  });

  it('shows every operational status at desktop widths while retaining mobile scroll', () => {
    expect(rail).toContain('overflow-x-auto md:grid md:grid-cols-5 md:overflow-visible');
    expect(rail).toContain('md:min-w-0 md:flex-wrap');
  });

  it('keeps the desktop sidebar at its explicit open or collapsed width', () => {
    expect(sidebar).not.toContain('md:!w-auto');
    expect(sidebar).toContain('md:!w-[380px]');
    expect(sidebar).toContain('md:!w-[64px]');
  });

  it('does not force five or six dashboard columns into a sidebar-constrained 1280px shell', () => {
    expect(dashboard).toContain('sm:grid-cols-3 2xl:grid-cols-6');
    expect(dashboard).toContain('lg:grid-cols-3 2xl:grid-cols-5');
  });
});