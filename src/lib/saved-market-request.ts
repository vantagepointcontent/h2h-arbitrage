type SavedMarketPatch = {
  id: string;
  eventTitle?: string;
  expiryDate?: string | null;
  category?: string;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseSavedMarketId(value: unknown): string | null {
  const id = nonEmptyString(value);
  return id && id.length <= 200 ? id : null;
}

export function parseSavedMarketPatch(body: Record<string, unknown>): SavedMarketPatch | { error: string } {
  const id = parseSavedMarketId(body.id);
  if (!id) return { error: 'Missing or invalid id.' };
  const allowed = new Set(['id', 'eventTitle', 'expiryDate', 'category']);
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
  if (Object.keys(patch).length === 1) return { error: 'Provide at least one update field.' };
  return patch;
}
