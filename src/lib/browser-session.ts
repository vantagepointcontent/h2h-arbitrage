export const BROWSER_SESSION_COOKIE = 'h2h_browser_session';
export const BROWSER_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

interface SessionOptions {
  now?: number;
  nonce?: string;
  maxAgeSeconds?: number;
}

interface BrowserSession {
  value: string;
  expiresAt: number;
  maxAgeSeconds: number;
}

function sessionSecret(): string | null {
  return process.env.H2H_BROWSER_SESSION_SECRET || process.env.H2H_API_TOKEN || null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function signature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signed));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function createBrowserSession(options: SessionOptions = {}): Promise<BrowserSession> {
  const secret = sessionSecret();
  if (!secret) throw new Error('Browser session signing secret is not configured');
  const now = options.now ?? Date.now();
  const maxAgeSeconds = options.maxAgeSeconds ?? BROWSER_SESSION_MAX_AGE_SECONDS;
  const expiresAt = now + maxAgeSeconds * 1000;
  const random = new Uint8Array(18);
  crypto.getRandomValues(random);
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    version: 1,
    expiresAt,
    nonce: options.nonce ?? bytesToBase64Url(random),
  })));
  return { value: `${payload}.${await signature(payload, secret)}`, expiresAt, maxAgeSeconds };
}

export async function verifyBrowserSession(
  value: string | null | undefined,
  options: Pick<SessionOptions, 'now'> = {},
): Promise<boolean> {
  const secret = sessionSecret();
  if (!secret || !value) return false;
  const separator = value.lastIndexOf('.');
  if (separator <= 0 || separator === value.length - 1) return false;
  const payload = value.slice(0, separator);
  const providedSignature = base64UrlToBytes(value.slice(separator + 1));
  const expectedSignature = base64UrlToBytes(await signature(payload, secret));
  if (!providedSignature || !expectedSignature || !equalBytes(providedSignature, expectedSignature)) return false;
  try {
    const payloadBytes = base64UrlToBytes(payload);
    if (!payloadBytes) return false;
    const decoded = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
    return decoded.version === 1
      && typeof decoded.expiresAt === 'number'
      && Number.isSafeInteger(decoded.expiresAt)
      && decoded.expiresAt > (options.now ?? Date.now());
  } catch {
    return false;
  }
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export async function isAuthorizedBrowserMutation(request: Request): Promise<boolean> {
  const apiToken = process.env.H2H_API_TOKEN;
  if (!apiToken) return true;
  if (request.headers.get('x-h2h-token') === apiToken) return true;
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) return false;
  return verifyBrowserSession(cookieValue(request, BROWSER_SESSION_COOKIE));
}
