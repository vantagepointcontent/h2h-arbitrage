export function planArtifactRetention(candidates, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 30 * 86_400_000;
  const remove = [];
  const keep = [];
  for (const candidate of candidates) {
    if (candidate.delivered === true && now - candidate.modifiedAtMs > maxAgeMs) remove.push(candidate);
    else keep.push(candidate);
  }
  return { keep, delete: remove };
}
