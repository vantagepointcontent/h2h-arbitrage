export function planBackupRetention(candidates, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = (options.maxAgeDays ?? 14) * 86_400_000;
  const keepNewest = options.keepNewest ?? 3;
  const protectedNames = options.protectedNames ?? new Set();
  const ordered = [...candidates].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  const newestNames = new Set(ordered.slice(0, keepNewest).map((candidate) => candidate.name));
  const keep = [];
  const remove = [];
  for (const candidate of ordered) {
    const protectedEntry = protectedNames.has(candidate.name);
    const recent = now - candidate.modifiedAtMs <= maxAgeMs;
    if (protectedEntry || newestNames.has(candidate.name) || recent) keep.push(candidate);
    else remove.push(candidate);
  }
  return { keep, delete: remove };
}
