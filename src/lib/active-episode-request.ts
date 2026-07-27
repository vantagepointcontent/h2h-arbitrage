import { parseResourceId } from './resource-id';

export type ActiveEpisodeRequest =
  | { marketId: string; outcome: string | null }
  | { error: string };

export function parseActiveEpisodeRequest(params: {
  marketId?: string | null;
  outcome?: string | null;
}): ActiveEpisodeRequest {
  if (params.marketId == null || params.marketId.trim() === '') {
    return { error: 'marketId is required' };
  }

  const marketId = parseResourceId(params.marketId);
  if (!marketId) return { error: 'marketId is invalid' };

  if (params.outcome == null) return { marketId, outcome: null };

  const outcome = parseResourceId(params.outcome);
  if (!outcome) return { error: 'outcome is invalid' };

  return { marketId, outcome };
}
