import type { ActionStatus, AnalyticsDecisionFact, ExternalActorId, RepositoryMode, TrackedPullRequest } from "@triagepilot/contracts";

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
  const tier = object(details.risk).tier;
  const riskTier = row.action !== "configuration_failure" && (tier === "low" || tier === "medium" || tier === "high") ? tier : null;
  const quota = object(details.routing).requestedReviewerCount;
  const requiredReviews = row.action === "configuration_failure" ? null
    : row.action === "policy_approval" && riskTier === "low" ? 0
    : (row.action === "request_human_review" || row.action === "no_eligible_reviewer") && riskTier !== null
      ? quota === 1 || quota === 2 ? quota : riskTier === "medium" && quota === undefined ? 1 : null
      : null;
  return { decisionId: row.id, changeRequest: row.changeRequest, createdAt: row.created_at.toISOString(), actionAppliedAt: row.action_applied_at?.toISOString() ?? null, mode: row.mode, action: row.action, actionStatus: row.action_status, riskScore: riskTier !== null && Number.isFinite(row.risk_score) ? row.risk_score : null, riskTier, requiredReviews };
}
