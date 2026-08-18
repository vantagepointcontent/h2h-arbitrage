export function planBackupRetention(candidates, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = (options.maxAgeDays ?? 14) * 86_400_000;
  const keepNewest = options.keepNewest ?? 3;
  const protectedNames = options.protectedNames ?? new Set();
  const ordered = [...candidates].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  const newestNames = new Set(ordered.slice(0, keepNewest).map((candidate) => candidate.name));
  const requiredReclaimBytes = Math.max(0, Number(options.requiredReclaimBytes) || 0);
  const keep = [];
  const remove = [];
  for (const candidate of ordered) {
    const protectedEntry = protectedNames.has(candidate.name);
    const recent = now - candidate.modifiedAtMs <= maxAgeMs;
    if (protectedEntry || newestNames.has(candidate.name) || recent) keep.push(candidate);
    else remove.push(candidate);
  }
  let reclaimableBytes = remove.reduce((sum, candidate) => sum + (candidate.bytes || 0), 0);
  if (reclaimableBytes < requiredReclaimBytes) {
    const pressureCandidates = keep
      .filter((candidate) => !protectedNames.has(candidate.name) && !newestNames.has(candidate.name))
      .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
    for (const candidate of pressureCandidates) {
      if (reclaimableBytes >= requiredReclaimBytes) break;
      keep.splice(keep.indexOf(candidate), 1);
      remove.push(candidate);
      reclaimableBytes += candidate.bytes || 0;
    }
  }
  return { keep, delete: remove, reclaimableBytes };
}
