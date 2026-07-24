import type { MarketLink } from './platforms/types';

type SavedMarketPatch = {
  id: string;
  eventTitle?: string;
  expiryDate?: string | null;
  category?: string;
  kalshiUrl?: string;
  polymarketUrl?: string;
  platformLinks?: MarketLink[];
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function looksLikeUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function looksLikeKalshiUrl(value: string): boolean {
  return looksLikeUrl(value) && /kalshi\.com/.test(value);
}

function looksLikePolymarketUrl(value: string): boolean {
  return looksLikeUrl(value) && /polymarket\.com/.test(value);
}

function validPlatformLinks(value: unknown): MarketLink[] | null {
  if (!Array.isArray(value)) return null;
  const out: MarketLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const platform = nonEmptyString((item as any).platform);
    const url = nonEmptyString((item as any).url);
    if (!platform || !url) return null;
    if (!looksLikeUrl(url)) return null;
    out.push({ platform, url });
  }
  return out;
}

export function parseSavedMarketId(value: unknown): string | null {
  const id = nonEmptyString(value);
  return id && id.length <= 200 ? id : null;
}

export function parseSavedMarketPatch(body: Record<string, unknown>): SavedMarketPatch | { error: string } {
  const id = parseSavedMarketId(body.id);
  if (!id) return { error: 'Missing or invalid id.' };

  const allowed = new Set([
    'id', 'eventTitle', 'expiryDate', 'category',
    'kalshiUrl', 'polymarketUrl', 'platformLinks',
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { error: 'Unsupported update field.' };

  const patch: SavedMarketPatch = { id };

  if ('eventTitle' in body) {
    const value = nonEmptyString(body.eventTitle);
    if (!value) return { error: 'eventTitle must be a non-empty string.' };
    patch.eventTitle = value;
  }

  if ('category' in body) {
    if (typeof body.category !== 'string') return { error: 'category must be a string.' };
    patch.category = body.category.trim();
  }

  if ('expiryDate' in body) {
    if (body.expiryDate !== null && typeof body.expiryDate !== 'string') return { error: 'expiryDate must be a string or null.' };
    patch.expiryDate = body.expiryDate;
  }

  if ('kalshiUrl' in body) {
    const value = nonEmptyString(body.kalshiUrl);
    if (!value) return { error: 'kalshiUrl must be a non-empty string.' };
    if (!looksLikeKalshiUrl(value)) return { error: 'kalshiUrl must be a valid Kalshi URL.' };
    patch.kalshiUrl = value;
  }

  if ('polymarketUrl' in body) {
    const value = nonEmptyString(body.polymarketUrl);
    if (!value) return { error: 'polymarketUrl must be a non-empty string.' };
    if (!looksLikePolymarketUrl(value)) return { error: 'polymarketUrl must be a valid Polymarket URL.' };
    patch.polymarketUrl = value;
  }

  if ('platformLinks' in body) {
    const value = validPlatformLinks(body.platformLinks);
    if (value === null) return { error: 'platformLinks must be an array of {platform, url} objects with valid URLs.' };
    patch.platformLinks = value;
  }

  if (Object.keys(patch).length === 1) return { error: 'Provide at least one update field.' };
  return patch;
}
