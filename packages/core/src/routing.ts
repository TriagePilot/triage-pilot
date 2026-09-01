import type { RiskTier, RoutingAction } from "@triagepilot/contracts";

import { normalizeReviewer, selectTieredReviewers, uniqueReviewers } from "./reviewer-selection.js";

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
  const reviewersToRequest = selectTieredReviewers({
    candidates,
    preferredReviewers: input.preferredReviewers ?? [],
    load: input.load,
    selectionKey: input.selectionKey,
    count: requestedReviewerCount,
  });
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
