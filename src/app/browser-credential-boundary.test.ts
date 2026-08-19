import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

const read = (path: string) => readFileSync(`${process.cwd()}/${path}`, 'utf8');

describe('browser credential boundary', () => {
  it('keeps the service credential out of client components and runtime configuration', () => {
    const clientSources = [
      'src/app/layout.tsx',
      'src/app/components/SettingsPanel.tsx',
      'src/app/components/BotTraderPanel.tsx',
      'src/app/components/BotTraderMessages.tsx',
    ].map(read).join('\n');
    const ecosystem = read('ecosystem.config.js');
    const sessionSource = read('src/lib/browser-session.ts');

    expect(clientSources).not.toContain('ApiTokenProvider');
    expect(clientSources).not.toContain('NEXT_PUBLIC_H2H_API_TOKEN');
    expect(clientSources).not.toContain('h2h-api-token');
    expect(clientSources).not.toContain("headers['x-h2h-token']");
    expect(ecosystem).not.toContain('NEXT_PUBLIC_H2H_API_TOKEN');
    expect(sessionSource).not.toContain("from 'node:crypto'");
    expect(sessionSource).not.toContain('Buffer.');
  });
});
