export function semverTuple(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value ?? "");
  return match ? match.slice(1).map(Number) : null;
}

export function isLaterReleaseVersion(candidate, baseline) {
  const candidateTuple = semverTuple(candidate);
  const baselineTuple = semverTuple(baseline);
  if (candidateTuple === null || baselineTuple === null) return false;
  for (let index = 0; index < candidateTuple.length; index += 1) {
    if (candidateTuple[index] !== baselineTuple[index]) {
      return candidateTuple[index] > baselineTuple[index];
    }
  }
  return false;
}
