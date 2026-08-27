import {
  activeApprovedReviewers as activeApprovedActors,
  evaluateHumanReviewPolicy as evaluatePolicy,
  type HumanReviewPolicyEvaluation,
  type HumanReviewPolicyState,
  type ReviewMetadata,
} from "@triagepilot/core";
import type { PullRequestReview } from "@triagepilot/provider-github";

export type { HumanReviewPolicyState };

export interface HumanReviewPolicyEvaluationInput {
  route: "no_human" | "human_review" | "no_eligible_reviewer";
  selectedReviewers: string[];
  requiredApprovalCount?: number;
  headSha: string;
  reviews: PullRequestReview[];
}

export function evaluateHumanReviewPolicy(
  input: HumanReviewPolicyEvaluationInput,
): HumanReviewPolicyEvaluation {
  return evaluatePolicy({
    route: input.route,
    selectedReviewers: input.selectedReviewers,
    ...(input.requiredApprovalCount === undefined ? {} : { requiredApprovalCount: input.requiredApprovalCount }),
    reviews: input.reviews.map(toReviewMetadata),
  });
}

export function activeApprovedReviewers(reviews: PullRequestReview[]): string[] {
  return activeApprovedActors(reviews.map(toReviewMetadata));
}

function toReviewMetadata(review: PullRequestReview): ReviewMetadata {
  return {
    actor: review.userLogin,
    actorType: review.userType === undefined || review.userType === "User" ? "human" : "bot",
    state: review.state.toLowerCase(),
    submittedAt: review.submittedAt,
  };
}
