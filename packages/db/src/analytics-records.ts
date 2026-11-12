import type { ActionStatus, AnalyticsDecisionFact, ExternalActorId, RepositoryMode, TrackedPullRequest } from "@triagepilot/contracts";

import { readBranchExclusion } from "./decision-details.js";

/** Selected persistence columns plus the authorized repository identity. */
export interface AnalyticsDecisionRow {
  id: string;
  repository_id: string;
  change_request_id: string | null;
  pull_number: number | null;
  created_at: Date;
  action_applied_at: Date | null;
  mode: RepositoryMode;
  action: string;
  action_status: ActionStatus;
  risk_score: number;
  details: unknown;
  changeRequest: TrackedPullRequest;
}
export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function actors(value: unknown): ExternalActorId[] | null {
  return Array.isArray(value) && value.every((actor): actor is string => typeof actor === "string" && actor.trim() !== "") ? [...new Set(value)] : null;
}
export function readOriginalReviewerActors(details: unknown): ExternalActorId[] | null {
  return actors(object(object(details).routing).selectedReviewers);
}
export function normalizeAnalyticsDecision(row: AnalyticsDecisionRow): AnalyticsDecisionFact | null {
  if (!row.change_request_id?.trim() || !Number.isSafeInteger(row.pull_number) || row.pull_number! <= 0) return null;
  if (row.action !== "policy_approval" && row.action !== "request_human_review" && row.action !== "no_eligible_reviewer" && row.action !== "configuration_failure") return null;
  const details = object(row.details);
  const excluded = readBranchExclusion(details) !== undefined;
  const tier = object(details.risk).tier;
  const riskTier = !excluded && row.action !== "configuration_failure" && (tier === "low" || tier === "medium" || tier === "high") ? tier : null;
  const routing = object(details.routing);
  const quota = routing.requestedReviewerCount;
  let requiredReviews: AnalyticsDecisionFact["requiredReviews"] = null;
  if (row.action === "policy_approval" && (excluded || riskTier === "low")) {
    requiredReviews = 0;
  } else if (row.action === "request_human_review" || row.action === "no_eligible_reviewer") {
    // An explicit historical quota remains reliable even when the tier is missing.
    if (quota === 1 || quota === 2) requiredReviews = quota;
    else if (riskTier === "medium" && quota === undefined) requiredReviews = 1;
  }
  const shortfall = routing.reviewerShortfall;
  const reviewerShortfall = row.action !== "configuration_failure"
    && typeof shortfall === "number" && Number.isSafeInteger(shortfall)
    && shortfall >= 0 && shortfall <= (requiredReviews ?? 2) ? shortfall : null;
  return {
    decisionId: row.id, changeRequest: row.changeRequest,
    createdAt: row.created_at.toISOString(), actionAppliedAt: row.action_applied_at?.toISOString() ?? null,
    mode: row.mode, action: row.action, actionStatus: row.action_status,
    riskScore: !excluded && row.action !== "configuration_failure" && Number.isFinite(row.risk_score) ? row.risk_score : null,
    riskTier, requiredReviews, reviewerShortfall,
  };
}
