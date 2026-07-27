type AllMarketsRequest = {
  kalshiUrl: string | null;
  pmUrl: string | null;
};

function parsePlatformUrl(
  value: string | null,
  platform: 'kalshi' | 'polymarket',
): string | null | { error: string } {
  if (value === null || value.trim() === '') return null;
  const url = value.trim();
  if (url.length > 2_048) return { error: `Invalid ${platform} URL.` };

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const expectedHost = `${platform}.com`;
    const allowedHost = hostname === expectedHost || hostname === `www.${expectedHost}`;
    const expectedPath = platform === 'kalshi' ? '/markets/' : '/(event|market|sports)/';
    const hasExpectedPath = platform === 'kalshi'
      ? parsed.pathname.startsWith(expectedPath)
      : /^\/(?:event|market|sports)\//.test(parsed.pathname);

    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !allowedHost || !hasExpectedPath) {
      return { error: `Invalid ${platform} URL.` };
    }
    return url;
  } catch {
    return { error: `Invalid ${platform} URL.` };
  }
}

/** Validates optional event-scoped platform URLs before upstream requests. */
export function parseAllMarketsRequest(
  rawKalshiUrl: string | null,
  rawPmUrl: string | null,
): AllMarketsRequest | { error: string } {
  const kalshiUrl = parsePlatformUrl(rawKalshiUrl, 'kalshi');
  if (kalshiUrl && typeof kalshiUrl === 'object') return kalshiUrl;

  const pmUrl = parsePlatformUrl(rawPmUrl, 'polymarket');
  if (pmUrl && typeof pmUrl === 'object') return pmUrl;

  return { kalshiUrl, pmUrl };
}
