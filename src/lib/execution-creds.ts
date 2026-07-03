/**
 * HOOKUP-04 (FEAT-006): Execution credential management.
 *
 * Credentials live in .env.local (chmod 600, gitignored). This module NEVER
 * returns secret values — only presence/absence status. Writes are
 * allow-listed to known credential keys and update-in-place or append.
 *
 * MANUAL EXECUTION ONLY: nothing in the codebase may call the execution
 * pipeline automatically. See /api/execute (POST requires an explicit,
 * user-initiated request).
 */
import { promises as fs } from 'fs';
import path from 'path';

const ENV_FILE = path.join(process.cwd(), '.env.local');

/** Allow-listed credential keys that may be written via the API. */
export const CREDENTIAL_KEYS = [
  'KALSHI_API_KEY_ID',
  'KALSHI_API_PRIVATE_KEY',
  'POLYMARKET_PRIVATE_KEY',   // EOA wallet key for CLOB EIP-712 signing
  'POLYMARKET_API_KEY',       // CLOB L2 api key
  'POLYMARKET_API_SECRET',
  'POLYMARKET_API_PASSPHRASE',
] as const;
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

export interface CredentialStatus {
  kalshi: {
    keyId: boolean;
    privateKey: boolean;
    ready: boolean;
  };
  polymarket: {
    walletKey: boolean;
    apiKey: boolean;
    apiSecret: boolean;
    apiPassphrase: boolean;
    ready: boolean;
  };
  /** True when every leg of a real execution could authenticate. */
  allReady: boolean;
}

async function readEnvFile(): Promise<string> {
  try {
    return await fs.readFile(ENV_FILE, 'utf-8');
  } catch {
    return '';
  }
}

/** Presence check: process.env first (already loaded), then .env.local text
 *  (covers keys added after boot, pending restart). */
async function present(key: CredentialKey): Promise<boolean> {
  if (process.env[key] && process.env[key]!.trim().length > 0) return true;
  const text = await readEnvFile();
  const re = new RegExp(`^${key}=.+`, 'm');
  return re.test(text);
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  const [kId, kPk, pmWallet, pmKey, pmSecret, pmPass] = await Promise.all([
    present('KALSHI_API_KEY_ID'),
    present('KALSHI_API_PRIVATE_KEY'),
    present('POLYMARKET_PRIVATE_KEY'),
    present('POLYMARKET_API_KEY'),
    present('POLYMARKET_API_SECRET'),
    present('POLYMARKET_API_PASSPHRASE'),
  ]);
  const kalshiReady = kId && kPk;
  const pmReady = pmWallet && pmKey && pmSecret && pmPass;
  return {
    kalshi: { keyId: kId, privateKey: kPk, ready: kalshiReady },
    polymarket: {
      walletKey: pmWallet,
      apiKey: pmKey,
      apiSecret: pmSecret,
      apiPassphrase: pmPass,
      ready: pmReady,
    },
    allReady: kalshiReady && pmReady,
  };
}

/** Split env text into blocks: a block starts at a `KEY=` line and includes
 *  any following continuation lines (multi-line PEM values) until the next
 *  `KEY=` line, comment, or blank line group. */
function replaceOrAppendBlock(text: string, key: string, line: string): string {
  const lines = text.split('\n');
  const isAssign = (l: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l);
  const out: string[] = [];
  let i = 0;
  let replaced = false;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith(`${key}=`)) {
      // Skip this line + continuation lines (anything until next assignment/comment/blank)
      i++;
      while (i < lines.length && lines[i] !== '' && !isAssign(lines[i]) && !lines[i].startsWith('#')) i++;
      out.push(line);
      replaced = true;
    } else {
      out.push(l);
      i++;
    }
  }
  if (!replaced) {
    while (out.length && out[out.length - 1] === '') out.pop();
    out.push(line);
  }
  return out.join('\n') + (out[out.length - 1] === '' ? '' : '\n');
}

/**
 * Write/update a credential in .env.local. Multi-line values (PEM keys) are
 * stored JSON-quoted on a single line (dotenv-compatible \n escapes).
 * Returns nothing; never echoes the value back.
 */
export async function saveCredential(key: string, value: string): Promise<void> {
  if (!(CREDENTIAL_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Key not allowed: ${key}`);
  }
  const clean = value.trim();
  if (!clean) throw new Error('Empty credential value');
  const line = `${key}=${clean.includes('\n') ? JSON.stringify(clean) : clean}`;

  const text = await readEnvFile();
  await fs.writeFile(ENV_FILE, replaceOrAppendBlock(text, key, line), { mode: 0o600 });
  // Make the credential available to THIS process immediately (no restart
  // needed for status checks; signing helpers read process.env lazily too).
  process.env[key] = clean;
}

export async function removeCredential(key: string): Promise<void> {
  if (!(CREDENTIAL_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Key not allowed: ${key}`);
  }
  const text = await readEnvFile();
  const lines = text.split('\n');
  const isAssign = (l: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith(`${key}=`)) {
      i++;
      while (i < lines.length && lines[i] !== '' && !isAssign(lines[i]) && !lines[i].startsWith('#')) i++;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  await fs.writeFile(ENV_FILE, out.join('\n'), { mode: 0o600 });
  delete process.env[key];
}
