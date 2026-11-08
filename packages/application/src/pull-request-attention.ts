import type { QueueAssessment, QueueAttention, QueuePullRequest, QueueReviewState } from "@triagepilot/contracts";
import { activeApprovedReviewers, evaluateHumanReviewPolicy } from "@triagepilot/core";

export function classifyPullRequestAttention(input: { pullRequest: QueuePullRequest; reviewState: QueueReviewState; assessment: QueueAssessment | null }): QueueAttention {
  const { pullRequest: pr, reviewState, assessment } = input;
  const opened = reviewState.lifecycle.openedSince === null ? NaN : Date.parse(reviewState.lifecycle.openedSince);
  const created = assessment === null ? NaN : Date.parse(assessment.createdAt);
  const identityCurrent = assessment !== null && assessment.headRevision === pr.headRevision && assessment.repositoryConfigRevision !== null && assessment.repositoryConfigRevision === pr.baseRevision && reviewState.lifecycle.status === "complete" && Number.isFinite(opened) && Number.isFinite(created) && created >= opened;
  const assessmentStatus: QueueAttention["assessmentStatus"] = assessment === null ? "missing" : identityCurrent ? "current" : "historical";
  const route = assessment?.action === "policy_approval" ? "no_human" : assessment?.action === "request_human_review" ? "human_review" : assessment?.action === "no_eligible_reviewer" ? "no_eligible_reviewer" : null;
  const current = identityCurrent && assessment !== null && assessment.mode === "enforce" && assessment.actionStatus === "succeeded" && assessment.requiredReviews !== null && route !== null && (assessment.policyCheckState === "success" || assessment.policyCheckState === "in_progress" || assessment.policyCheckState === "failure");
  const reviews = reviewState.reviews.map((r) => ({ actor: r.actor.id, actorType: r.actor.type, state: r.state.toLowerCase(), submittedAt: r.submittedAt }));
  const approvedCount = reviewState.status === "complete" ? activeApprovedReviewers(reviews).length : null;
  const requiredCount = current ? assessment.requiredReviews : null;
  const evaluation = current && assessment.requiredReviews !== null && approvedCount !== null ? evaluateHumanReviewPolicy({ route, selectedReviewers: assessment.selectedActors, requiredApprovalCount: assessment.requiredReviews, reviews }) : null;
  const sufficient = current && assessment.requiredReviews !== null && approvedCount !== null && approvedCount >= assessment.requiredReviews;
  const secondaryReasons: string[] = [];
  if (assessment?.policyCheckState === "failure") secondaryReasons.push(`Policy check failed${assessment.failureReason ? `: ${assessment.failureReason}` : "."}`);
  if (assessment?.mode === "shadow") secondaryReasons.push("The assessment is a shadow projection, not an applied requirement.");
  else if (assessmentStatus === "historical") secondaryReasons.push("The assessment is historical and may not apply to this pull request.");
  const result = (group: QueueAttention["group"], badge: QueueAttention["badge"], reason: string, actorIds: string[] = [], teamIds: string[] = [], checkUpdatePending = false): QueueAttention => ({ group, badge, reason, actorIds, teamIds, secondaryReasons, approvedCount, requiredCount, assessmentStatus, checkUpdatePending });
  if (pr.isDraft) return result("other", "draft", "Pull request is a draft.", [pr.author.id]);
  if (reviewState.status !== "complete") return result("other", "status_unknown", "Review state is unavailable or changed during acquisition.");

  const latest = new Map<string, { state: string; time: number; index: number }>();
  reviewState.reviews.forEach((review, index) => {
    const state = review.state.toLowerCase();
    const time = review.submittedAt === null ? NaN : Date.parse(review.submittedAt);
    if (review.actor.type !== "human" || !Number.isFinite(time) || !["approved", "changes_requested", "dismissed"].includes(state)) return;
    const previous = latest.get(review.actor.id);
    if (!previous || time > previous.time || (time === previous.time && index > previous.index)) latest.set(review.actor.id, { state, time, index });
  });
  const users = pr.requestedUsers.filter((user) => user.type === "human").map((user) => user.id);
  const teams = pr.requestedTeams.map((team) => team.id);
  const blockers = [...latest].filter(([id, entry]) => entry.state === "changes_requested" && !users.includes(id)).map(([id]) => id);
  if (blockers.length) {
    if (users.length || teams.length) secondaryReasons.push("Other review requests are also outstanding.");
    return result("authors", "authors_move", "Changes requested by a reviewer need the author's attention.", [pr.author.id]);
  }
  if (users.length || teams.length) {
    if (sufficient) secondaryReasons.push("The live human approval count meets the current requirement.");
    return result("reviewers", "reviewers_move", "Human review requests are outstanding.", users, teams);
  }
  if (current && approvedCount !== null && !sufficient) return result("reviewer_gap", "needs_reviewer", evaluation?.summary ?? "More human approvals are required; no human review request is outstanding.");
  if (current && sufficient && assessment.policyCheckState !== "failure") return result("policy_met", "policy_met", "The current human review requirement is met.", [], [], assessment.policyCheckState === "in_progress");
  return result("other", "policy_unknown", "Current applied review policy could not be established.");
}
