import type { RiskTier, RoutingAction } from "@triagepilot/shared";

export interface RoutingInput {
  risk: { score: number; tier: RiskTier };
  author: string;
  eligibleReviewers: string[];
  load: Record<string, number>;
  highRiskReviewers: 1 | 2;
  selectionKey: string;
}

export interface RoutingDecision {
  action: Exclude<RoutingAction, "configuration_failure">;
  candidates: string[];
  requestedReviewerCount: number;
  selectedReviewers: string[];
  reviewerShortfall: number;
  noHumanReason?: string;
  loadSnapshot: Record<string, number>;
}

export function decideRouting(input: RoutingInput): RoutingDecision {
  const candidates = input.eligibleReviewers.filter((reviewer) => reviewer !== input.author).sort();
  const loadSnapshot = Object.fromEntries(candidates.map((candidate) => [candidate, input.load[candidate] ?? 0]));

  if (input.risk.tier === "low") {
    return {
      action: "policy_approval",
      candidates,
      requestedReviewerCount: 0,
      selectedReviewers: [],
      reviewerShortfall: 0,
      noHumanReason: "risk_at_or_below_low_threshold",
      loadSnapshot,
    };
  }

  const requestedReviewerCount = input.risk.tier === "high" ? input.highRiskReviewers : 1;
  const selectedReviewers = selectLowestLoadReviewers(
    candidates,
    input.load,
    input.selectionKey,
    requestedReviewerCount,
  );
  const reviewerShortfall = requestedReviewerCount - selectedReviewers.length;

  if (candidates.length === 0) {
    return {
      action: "no_eligible_reviewer",
      candidates,
      requestedReviewerCount,
      selectedReviewers,
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
    reviewerShortfall,
    loadSnapshot,
  };
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
