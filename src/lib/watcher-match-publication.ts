import { reserveSavedMarketPublication } from './persistence';
import { captureCouplingDependencies, type CouplingDependency } from './coupling-store';

export interface WatcherMatchedPair {
  artist: string;
  kalshiTicker: string;
  pmConditionId: string;
}

export interface WatcherMatchPublication {
  publicationGeneration: number;
  matchedPairs: WatcherMatchedPair[];
  matchDependencies: CouplingDependency[];
}

/** Capture the live channel generation and exact canonical coupling revisions
 * before watcher computation starts. Publication revalidates both fences. */
export async function reserveWatcherMatchPublication(
  marketId: string,
  matchedPairs: WatcherMatchedPair[],
): Promise<WatcherMatchPublication | null> {
  const publicationGeneration = await reserveSavedMarketPublication(marketId, 'live');
  const matchDependencies = await captureCouplingDependencies(matchedPairs, 'watcher_compute');
  return matchDependencies.length === matchedPairs.length
    ? { publicationGeneration, matchedPairs, matchDependencies }
    : null;
}
