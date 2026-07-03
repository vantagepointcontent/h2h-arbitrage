import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Point the module at a temp .env.local via cwd mock
let tmpDir: string;
vi.mock('process', async (importOriginal) => importOriginal());

describe('execution-creds env file handling', () => {
  let mod: typeof import('./execution-creds');
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'creds-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    vi.resetModules();
    mod = await import('./execution-creds');
    for (const k of mod.CREDENTIAL_KEYS) delete process.env[k];
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    for (const k of mod.CREDENTIAL_KEYS) delete process.env[k];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const envPath = () => path.join(tmpDir, '.env.local');

  it('appends a new credential and reports it present', async () => {
    await fs.writeFile(envPath(), 'TELEGRAM_BOT_TOKEN=abc123\n');
    await mod.saveCredential('POLYMARKET_API_KEY', 'pk-test-1');
    const text = await fs.readFile(envPath(), 'utf-8');
    expect(text).toContain('TELEGRAM_BOT_TOKEN=abc123');
    expect(text).toContain('POLYMARKET_API_KEY=pk-test-1');
    const status = await mod.getCredentialStatus();
    expect(status.polymarket.apiKey).toBe(true);
  });

  it('replaces an existing multi-line PEM block without touching neighbors', async () => {
    const pem = 'KALSHI_API_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEfakefakefake\nQWERTYfakeline\n-----END RSA PRIVATE KEY-----';
    await fs.writeFile(envPath(), `AAA_FIRST=1\n${pem}\nTELEGRAM_BOT_TOKEN=abc\n`);
    await mod.saveCredential('KALSHI_API_PRIVATE_KEY', 'new-single-line-key');
    const text = await fs.readFile(envPath(), 'utf-8');
    expect(text).toContain('AAA_FIRST=1');
    expect(text).toContain('TELEGRAM_BOT_TOKEN=abc');
    expect(text).toContain('KALSHI_API_PRIVATE_KEY=new-single-line-key');
    expect(text).not.toContain('MIIEfakefakefake');
    expect(text).not.toContain('-----END RSA PRIVATE KEY-----');
  });

  it('stores multi-line values JSON-quoted on one line', async () => {
    const pem = '-----BEGIN KEY-----\nabc\n-----END KEY-----';
    await mod.saveCredential('POLYMARKET_PRIVATE_KEY', pem);
    const text = await fs.readFile(envPath(), 'utf-8');
    const line = text.split('\n').find((l) => l.startsWith('POLYMARKET_PRIVATE_KEY='))!;
    expect(line).toBeDefined();
    expect(JSON.parse(line.slice('POLYMARKET_PRIVATE_KEY='.length))).toBe(pem);
  });

  it('rejects non-allow-listed keys', async () => {
    await expect(mod.saveCredential('EVIL_KEY', 'x')).rejects.toThrow(/not allowed/);
    await expect(mod.removeCredential('PATH')).rejects.toThrow(/not allowed/);
  });

  it('rejects empty values', async () => {
    await expect(mod.saveCredential('POLYMARKET_API_KEY', '   ')).rejects.toThrow(/Empty/);
  });

  it('removeCredential deletes the key and its continuation lines', async () => {
    await fs.writeFile(envPath(), 'POLYMARKET_API_SECRET=shh\nTELEGRAM_BOT_TOKEN=abc\n');
    await mod.removeCredential('POLYMARKET_API_SECRET');
    const text = await fs.readFile(envPath(), 'utf-8');
    expect(text).not.toContain('POLYMARKET_API_SECRET');
    expect(text).toContain('TELEGRAM_BOT_TOKEN=abc');
    const status = await mod.getCredentialStatus();
    expect(status.polymarket.apiSecret).toBe(false);
  });

  it('never reports secret values, only booleans', async () => {
    await mod.saveCredential('POLYMARKET_API_KEY', 'super-secret-value');
    const status = await mod.getCredentialStatus();
    expect(JSON.stringify(status)).not.toContain('super-secret-value');
  });
});
