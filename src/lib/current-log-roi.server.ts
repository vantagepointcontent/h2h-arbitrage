import { getLatestCompletedScanRoiForLogIds, type PersistedCurrentLogRoi } from './persistence';

export type CurrentLogRoiValuation = PersistedCurrentLogRoi;

/**
 * Logs valuations are persisted snapshots only. This module intentionally has
 * no venue resolver, order-book, or scanner dependencies.
 */
export async function getCurrentLogRoiBatch(ids: number[]): Promise<CurrentLogRoiValuation[]> {
  return getLatestCompletedScanRoiForLogIds([...new Set(ids)]);
}
