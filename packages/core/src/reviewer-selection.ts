export function normalizeReviewer(reviewer: string): string {
  const normalized = reviewer.trim().replace(/^@/, "").toLowerCase();
  return normalized ? `@${normalized}` : "";
}

export function uniqueReviewers(reviewers: string[]): string[] {
  return [...new Set(reviewers.map(normalizeReviewer).filter(Boolean))];
}

export function selectTieredReviewers(input: {
  candidates: string[];
  preferredReviewers: string[];
  load: Record<string, number>;
  selectionKey: string;
  count: number;
}): string[] {
  const candidateSet = new Set(input.candidates);
  const preferredCandidates = uniqueReviewers(input.preferredReviewers).filter((reviewer) =>
    candidateSet.has(reviewer),
  );
  const preferredCandidateSet = new Set(preferredCandidates);
  const fallbackCandidates = input.candidates.filter((reviewer) => !preferredCandidateSet.has(reviewer));
  const selectedPreferredReviewers = selectLowestLoadReviewers(
    preferredCandidates,
    input.load,
    input.selectionKey,
    input.count,
  );
  const selectedFallbackReviewers = selectLowestLoadReviewers(
    fallbackCandidates,
    input.load,
    input.selectionKey,
    input.count - selectedPreferredReviewers.length,
  );

  return [...selectedPreferredReviewers, ...selectedFallbackReviewers];
}

function selectLowestLoadReviewers(
  candidates: string[],
  load: Record<string, number>,
  selectionKey: string,
  count: number,
): string[] {
  return [...candidates].sort((a, b) => {
    const loadDifference = (load[a] ?? 0) - (load[b] ?? 0);
    if (loadDifference !== 0) return loadDifference;

    const rankDifference = stableRank(`${selectionKey}:${a}`) - stableRank(`${selectionKey}:${b}`);
    return rankDifference === 0 ? a.localeCompare(b) : rankDifference;
  }).slice(0, count);
}

function stableRank(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
