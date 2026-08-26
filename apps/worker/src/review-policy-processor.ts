import type { HumanReviewPolicyDecision } from "@triagepilot/db";
import type { PullRequestReview } from "@triagepilot/github";
import type { HumanReviewPolicyJobPayload } from "@triagepilot/shared";

import { evaluateHumanReviewPolicy, type HumanReviewPolicyState } from "./review-policy";

export interface HumanReviewPolicyServices {
  findDecision(input: {
    repositoryId: string;
    pullNumber: number;
  }): Promise<HumanReviewPolicyDecision | null>;
  fetchPullRequest(input: HumanReviewPolicyJobPayload): Promise<{ state: string; headSha: string }>;
  fetchReviews(input: HumanReviewPolicyJobPayload): Promise<PullRequestReview[]>;
  updateCheck(input: {
    decision: HumanReviewPolicyDecision;
    state: HumanReviewPolicyState;
    summary: string;
  }): Promise<void>;
  persistState(input: { decisionId: string; state: HumanReviewPolicyState }): Promise<void>;
  failPolicyCheck?(summary: string, decisionId?: string): Promise<void>;
  policyCheckFailureDecisionId?(): string | null;
}

export async function processHumanReviewPolicyJob(
  message: HumanReviewPolicyJobPayload,
  services: HumanReviewPolicyServices,
): Promise<void> {
  const decision = await services.findDecision({
    repositoryId: message.repositoryId,
    pullNumber: message.pullNumber,
  });
  if (!decision || decision.mode !== "enforce") return;
  if (decision.policyCheckState === "failure") return;

  const route = routeForDecision(decision);
  if (route === null) return;

  const pullRequest = await services.fetchPullRequest(message);
  if (!isMatchingOpenHead(pullRequest, decision.headSha)) return;

  const reviews = await services.fetchReviews(message);
  const evaluation = evaluateHumanReviewPolicy({
    route,
    selectedReviewers: decision.selectedReviewers,
    ...(decision.requiredApprovalCount === undefined ? {} : { requiredApprovalCount: decision.requiredApprovalCount }),
    headSha: decision.headSha,
    reviews,
  });

  if (evaluation.state === "success") {
    const currentPullRequest = await services.fetchPullRequest(message);
    if (!isMatchingOpenHead(currentPullRequest, decision.headSha)) return;
  }

  await services.updateCheck({
    decision,
    state: evaluation.state,
    summary: evaluation.summary,
  });
  await services.persistState({
    decisionId: decision.decisionId,
    state: evaluation.state,
  });
}

function routeForDecision(
  decision: HumanReviewPolicyDecision,
): "no_human" | "human_review" | "no_eligible_reviewer" | null {
  if (decision.action === "policy_approval") return "no_human";
  if (decision.action === "request_human_review") return "human_review";
  if (decision.action === "no_eligible_reviewer") return "no_eligible_reviewer";
  return null;
}

function isMatchingOpenHead(
  pullRequest: { state: string; headSha: string },
  expectedHeadSha: string,
): boolean {
  return pullRequest.state === "open" && pullRequest.headSha === expectedHeadSha;
}
