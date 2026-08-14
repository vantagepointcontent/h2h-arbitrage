export interface LegacyBotPositionIdentity {
  id: number;
  status: string;
  pmConditionId: string | null;
  pmEntryTokenId: string | null;
  pmExitTokenId: string | null;
  pmSide: 'yes' | 'no';
}

export interface PolymarketSnapshotIdentity {
  marketId: string;
  side: 'yes' | 'no';
  tokenId: string | null;
}

export interface BotPositionIdentityCorrection {
  id: number;
  oldPmConditionId: string | null;
  oldPmEntryTokenId: string | null;
  oldPmExitTokenId: string | null;
  pmConditionId: string;
  pmEntryTokenId: string | null;
  pmExitTokenId: string | null;
}

export interface BotPositionIdentityMigrationPlan {
  corrections: BotPositionIdentityCorrection[];
  unresolved: Array<{ id: number; reason: string }>;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function isConditionId(value: string | null): value is string {
  return value != null && /^0x[0-9a-f]{64}$/i.test(value.trim());
}

function isTokenId(value: string | null): value is string {
  return value != null && /^(?:0|[1-9]\d*)$/.test(value.trim());
}

export function planBotPositionPmIdentityMigration(
  positions: LegacyBotPositionIdentity[],
  snapshots: PolymarketSnapshotIdentity[],
): BotPositionIdentityMigrationPlan {
  const tokenParents = new Map<string, Set<string>>();
  const heldTokens = new Map<string, Set<string>>();

  for (const snapshot of snapshots) {
    if (!isConditionId(snapshot.marketId) || !isTokenId(snapshot.tokenId)) continue;
    const parent = normalize(snapshot.marketId);
    const token = snapshot.tokenId.trim();
    const parents = tokenParents.get(token) ?? new Set<string>();
    parents.add(parent);
    tokenParents.set(token, parents);
    const heldKey = `${parent}|${snapshot.side}`;
    const tokens = heldTokens.get(heldKey) ?? new Set<string>();
    tokens.add(token);
    heldTokens.set(heldKey, tokens);
  }

  const corrections: BotPositionIdentityCorrection[] = [];
  const unresolved: Array<{ id: number; reason: string }> = [];

  for (const position of [...positions].sort((a, b) => a.id - b.id)) {
    if (position.status !== 'open') continue;
    const parentCandidates = new Set<string>();
    if (isConditionId(position.pmConditionId)) {
      parentCandidates.add(normalize(position.pmConditionId));
    }
    for (const identifier of [position.pmConditionId, position.pmEntryTokenId, position.pmExitTokenId]) {
      if (!isTokenId(identifier)) continue;
      for (const parent of tokenParents.get(identifier.trim()) ?? []) parentCandidates.add(parent);
    }
    if (parentCandidates.size === 0) {
      unresolved.push({ id: position.id, reason: 'No parent conditionId could be derived from persisted snapshot evidence' });
      continue;
    }
    if (parentCandidates.size !== 1) {
      unresolved.push({ id: position.id, reason: 'Ambiguous parent conditionId across persisted snapshot evidence' });
      continue;
    }
    const pmConditionId = [...parentCandidates][0];
    const sideTokens = heldTokens.get(`${pmConditionId}|${position.pmSide}`) ?? new Set<string>();
    if (sideTokens.size !== 1) {
      unresolved.push({
        id: position.id,
        reason: sideTokens.size === 0
          ? `No exact held-side ${position.pmSide.toUpperCase()} token exists in persisted snapshot evidence`
          : `Ambiguous held-side ${position.pmSide.toUpperCase()} token in persisted snapshot evidence`,
      });
      continue;
    }
    const heldToken = [...sideTokens][0];
    // A missing legacy token has no persisted fee-authority evidence. Do not
    // fabricate it from a valuation snapshot; only correct an existing token.
    const pmEntryTokenId = isTokenId(position.pmEntryTokenId) ? heldToken : null;
    const pmExitTokenId = isTokenId(position.pmExitTokenId) ? heldToken : null;
    if (normalize(position.pmConditionId ?? '') === pmConditionId
      && position.pmEntryTokenId === pmEntryTokenId
      && position.pmExitTokenId === pmExitTokenId) continue;
    corrections.push({
      id: position.id,
      oldPmConditionId: position.pmConditionId,
      oldPmEntryTokenId: position.pmEntryTokenId,
      oldPmExitTokenId: position.pmExitTokenId,
      pmConditionId,
      pmEntryTokenId,
      pmExitTokenId,
    });
  }

  return { corrections, unresolved };
}
