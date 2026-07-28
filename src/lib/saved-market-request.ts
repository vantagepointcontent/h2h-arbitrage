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

export type SavedMarketCreate = {
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  category: string;
  expiryDate: string | null;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Accept the date-only values emitted by MarketEditPanel and canonical ISO UTC timestamps. */
function validExpiryDate(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z)?$/);
  if (!match) return null;

  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second)
  ) return null;
  return text;
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
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (hostname === 'kalshi.com' || hostname === 'www.kalshi.com') && looksLikeUrl(value);
  } catch {
    return false;
  }
}

function looksLikePolymarketUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (hostname === 'polymarket.com' || hostname === 'www.polymarket.com') && looksLikeUrl(value);
  } catch {
    return false;
  }
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

/** Validate the public saved-market creation payload before it reaches persistence. */
export function parseSavedMarketCreate(body: Record<string, unknown>): SavedMarketCreate | { error: string } {
  const kalshiUrl = nonEmptyString(body.kalshiUrl);
  if (!kalshiUrl || !looksLikeKalshiUrl(kalshiUrl)) return { error: 'kalshiUrl must be a valid Kalshi URL.' };

  const polymarketUrl = nonEmptyString(body.polymarketUrl);
  if (!polymarketUrl || !looksLikePolymarketUrl(polymarketUrl)) return { error: 'polymarketUrl must be a valid Polymarket URL.' };

  if (body.eventTitle !== undefined && (typeof body.eventTitle !== 'string' || body.eventTitle.trim().length > 500)) return { error: 'eventTitle must be a string up to 500 characters.' };
  if (body.category !== undefined && (typeof body.category !== 'string' || body.category.trim().length > 200)) return { error: 'category must be a string up to 200 characters.' };
  if (body.expiryDate !== undefined && body.expiryDate !== null && !validExpiryDate(body.expiryDate)) return { error: 'expiryDate must be a valid ISO date or null.' };

  return {
    kalshiUrl,
    polymarketUrl,
    eventTitle: typeof body.eventTitle === 'string' && body.eventTitle.trim() ? body.eventTitle.trim() : 'Untitled',
    category: typeof body.category === 'string' ? body.category.trim() : '',
    expiryDate: body.expiryDate === null ? null : validExpiryDate(body.expiryDate),
  };
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
    if (body.expiryDate !== null && !validExpiryDate(body.expiryDate)) return { error: 'expiryDate must be a valid ISO date or null.' };
    patch.expiryDate = body.expiryDate === null ? null : validExpiryDate(body.expiryDate)!;
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
