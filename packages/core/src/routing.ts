import type { RiskTier, RoutingAction } from "@triagepilot/contracts";

export interface RoutingInput {
  risk: { score: number; tier: RiskTier };
  author: string;
  preferredReviewers?: string[];
  eligibleReviewers: string[];
  existingApprovedReviewers?: string[];
  load: Record<string, number>;
  highRiskReviewers: 1 | 2;
  selectionKey: string;
}

export interface RoutingDecision {
  action: Exclude<RoutingAction, "configuration_failure">;
  candidates: string[];
  requestedReviewerCount: number;
  selectedReviewers: string[];
  reviewersToRequest: string[];
  reviewerShortfall: number;
  noHumanReason?: string;
  loadSnapshot: Record<string, number>;
}

export function decideRouting(input: RoutingInput): RoutingDecision {
  const existingApprovedReviewers = uniqueReviewers(input.existingApprovedReviewers ?? []).filter(
    (reviewer) => reviewer !== normalizeReviewer(input.author),
  );
  const candidates = uniqueReviewers(input.eligibleReviewers)
    .filter((reviewer) => reviewer !== normalizeReviewer(input.author) && !existingApprovedReviewers.includes(reviewer))
    .sort();
  const candidateSet = new Set(candidates);
  const preferredCandidates = uniqueReviewers(input.preferredReviewers ?? []).filter((reviewer) => candidateSet.has(reviewer));
  const preferredCandidateSet = new Set(preferredCandidates);
  const fallbackCandidates = candidates.filter((reviewer) => !preferredCandidateSet.has(reviewer));
  const loadSnapshot = Object.fromEntries(candidates.map((candidate) => [candidate, input.load[candidate] ?? 0]));

  if (input.risk.tier === "low") {
    return {
      action: "policy_approval",
      candidates,
      requestedReviewerCount: 0,
      selectedReviewers: [],
      reviewersToRequest: [],
      reviewerShortfall: 0,
      noHumanReason: "risk_at_or_below_low_threshold",
      loadSnapshot,
    };
  }

  const requestedReviewerCount = input.risk.tier === "high" ? input.highRiskReviewers : 1;
  const preferredReviewersToRequest = selectLowestLoadReviewers(
    preferredCandidates,
    input.load,
    input.selectionKey,
    requestedReviewerCount,
  );
  const fallbackReviewersToRequest = selectLowestLoadReviewers(
    fallbackCandidates,
    input.load,
    input.selectionKey,
    requestedReviewerCount - preferredReviewersToRequest.length,
  );
  const reviewersToRequest = [...preferredReviewersToRequest, ...fallbackReviewersToRequest];
  const selectedReviewers = reviewersToRequest;
  const reviewerShortfall = requestedReviewerCount - selectedReviewers.length;

  if (selectedReviewers.length === 0) {
    return {
      action: "no_eligible_reviewer",
      candidates,
      requestedReviewerCount,
      selectedReviewers,
      reviewersToRequest,
      reviewerShortfall,
      noHumanReason: "no_eligible_reviewer",
      loadSnapshot,
    };
  }

  return {
    action: "request_human_review",
    candidates,
    requestedReviewerCount,
    selectedReviewers,
    reviewersToRequest,
    reviewerShortfall,
    loadSnapshot,
  };
}

export function uniqueReviewers(reviewers: string[]): string[] {
  return [...new Set(reviewers.map(normalizeReviewer).filter(Boolean))];
}

export function normalizeReviewer(reviewer: string): string {
  const normalized = reviewer.trim().replace(/^@/, "").toLowerCase();
  return normalized ? `@${normalized}` : "";
}

export function selectLowestLoadReviewers(
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
