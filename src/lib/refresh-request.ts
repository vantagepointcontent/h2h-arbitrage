import { parseResourceId } from './resource-id';

export function parseRefreshStartRequest(body: Record<string, unknown>): { ids?: string[] } | { error: string } {
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'ids')) return { error: 'Unsupported refresh request field.' };
  if (!('ids' in body) || body.ids === undefined) return {};
  if (!Array.isArray(body.ids) || body.ids.length > 500) return { error: 'ids must be an array of at most 500 market IDs.' };
  const ids = body.ids.map(parseResourceId);
  if (ids.some((id) => !id)) return { error: 'ids contains an invalid market ID.' };
  return { ids: ids as string[] };
}
