// Kalshi API authentication helpers — RSA-PSS SHA256 signature scheme
// Docs: https://docs.kalshi.com/getting_started/quick_start_authenticated_requests
//
// The WebSocket handshake uses the same signature scheme as REST, but signs
// the literal path `/trade-api/ws/v2`.

import crypto from 'crypto';

const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID || '';
const KALSHI_API_PRIVATE_KEY = process.env.KALSHI_API_PRIVATE_KEY || '';

export function getKalshiCredentials(): { keyId: string; privateKey: string } {
  return { keyId: KALSHI_API_KEY_ID, privateKey: KALSHI_API_PRIVATE_KEY };
}

export function signKalshiRequest(method: string, path: string): { keyId: string; timestamp: string; signature: string } {
  const { keyId, privateKey } = getKalshiCredentials();
  if (!keyId || !privateKey) {
    throw new Error('Missing KALSHI_API_KEY_ID or KALSHI_API_PRIVATE_KEY');
  }

  const timestamp = Date.now().toString();
  const cleanPath = path.split('?')[0];
  const message = `${timestamp}${method.toUpperCase()}${cleanPath}`;

  const signature = crypto
    .createSign('RSA-SHA256')
    .update(message)
    .sign(privateKey, 'base64');

  return { keyId, timestamp, signature };
}

/**
 * RSA-PSS variant — required by the Kalshi WebSocket handshake
 * (wss://api.elections.kalshi.com/trade-api/ws/v2 rejects PKCS#1 v1.5).
 * Verified working 2026-07-03 with signed headers on the WS upgrade request.
 */
export function signKalshiRequestPss(method: string, path: string): { keyId: string; timestamp: string; signature: string } {
  const { keyId, privateKey } = getKalshiCredentials();
  if (!keyId || !privateKey) {
    throw new Error('Missing KALSHI_API_KEY_ID or KALSHI_API_PRIVATE_KEY');
  }

  const timestamp = Date.now().toString();
  const cleanPath = path.split('?')[0];
  const message = `${timestamp}${method.toUpperCase()}${cleanPath}`;

  const signature = crypto
    .sign('sha256', Buffer.from(message), {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString('base64');

  return { keyId, timestamp, signature };
}

/** Signed headers for the Kalshi WS upgrade request (PSS scheme). */
export function makeKalshiWsAuthHeaders(): Record<string, string> {
  const { keyId, timestamp, signature } = signKalshiRequestPss('GET', '/trade-api/ws/v2');
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
}

export function makeKalshiAuthHeaders(method: string, path: string): Record<string, string> {
  const { keyId, timestamp, signature } = signKalshiRequest(method, path);
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'Accept': 'application/json',
  };
}
