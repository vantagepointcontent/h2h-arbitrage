import manifest from '../../data/audits/bot-proposition-audit-v1.json';

export type HistoricalPropositionClassification = 'confirmed_legitimate' | 'confirmed_invalid' | 'unresolved_legacy';

export interface HistoricalPropositionAuditEntry {
  positionId: number;
  executionId: number;
  status: string;
  openedAt: string;
  kalshiTicker: string;
  pmConditionId: string;
  kalshiSide: string;
  pmSide: string;
  pmEntryTokenId: string | null;
  classification: HistoricalPropositionClassification;
  severity: 'high' | 'warning' | 'none';
  reason: string;
  evidence?: {
    kalshi?: { question?: string; payoutState?: string };
    polymarket?: { question?: string; payoutState?: string; tokenId?: string };
  };
}

const byExecutionId = new Map<number, HistoricalPropositionAuditEntry>(
  manifest.entries.map((entry) => [entry.executionId, entry as HistoricalPropositionAuditEntry]),
);

/** Immutable versioned audit overlay; never changes the historical trade row. */
export function historicalPropositionAudit(
  executionId: number,
  identity: { positionId: number; openedAt: string; kalshiTicker: string | null; pmConditionId: string | null; pmTokenId: string | null; kalshiSide: string; pmSide: string },
): HistoricalPropositionAuditEntry | null {
  const entry = byExecutionId.get(executionId);
  if (!entry
      || entry.positionId !== identity.positionId
      || entry.openedAt !== identity.openedAt
      || entry.kalshiTicker.toLowerCase() !== identity.kalshiTicker?.toLowerCase()
      || entry.pmConditionId.toLowerCase() !== identity.pmConditionId?.toLowerCase()
      || entry.pmEntryTokenId !== identity.pmTokenId
      || entry.kalshiSide !== identity.kalshiSide
      || entry.pmSide !== identity.pmSide) return null;
  return entry;
}

/** Display-only exact labels from a fingerprinted immutable audit finding. */
export function historicalAuditLegMetadata(entry: HistoricalPropositionAuditEntry | null): {
  kalshiMarketQuestion: string;
  pmMarketQuestion: string;
  kalshiOutcomeLabel: string;
  pmOutcomeLabel: string;
} | null {
  if (entry?.classification !== 'confirmed_invalid') return null;
  const kalshiQuestion = entry.evidence?.kalshi?.question?.trim();
  const pmQuestion = entry.evidence?.polymarket?.question?.trim();
  const kalshiOutcome = entry.evidence?.kalshi?.payoutState?.trim();
  const pmOutcome = entry.evidence?.polymarket?.payoutState?.trim();
  if (!kalshiQuestion || !pmQuestion || !kalshiOutcome || !pmOutcome) return null;
  return {
    kalshiMarketQuestion: kalshiQuestion,
    pmMarketQuestion: pmQuestion,
    kalshiOutcomeLabel: kalshiOutcome,
    pmOutcomeLabel: pmOutcome,
  };
}
