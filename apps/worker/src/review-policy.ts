import type { PullRequestReview } from "@triagepilot/github";

export type HumanReviewPolicyState = "in_progress" | "success" | "failure";

export interface HumanReviewPolicyEvaluationInput {
  route: "no_human" | "human_review" | "no_eligible_reviewer";
  selectedReviewers: string[];
  requiredApprovalCount?: number;
  headSha: string;
  reviews: PullRequestReview[];
}

export interface HumanReviewPolicyEvaluation {
  state: HumanReviewPolicyState;
  summary: string;
  missingReviewers: string[];
}

export function evaluateHumanReviewPolicy(
  input: HumanReviewPolicyEvaluationInput,
): HumanReviewPolicyEvaluation {
  if (input.route === "no_human") {
    return {
      state: "success",
      summary: "No human approval is required for this pull request.",
      missingReviewers: [],
    };
  }

  if (input.route === "no_eligible_reviewer") {
    return {
      state: "failure",
      summary: "No eligible human reviewer is available for this required review.",
      missingReviewers: [],
    };
  }

  const latestReviews = new Map<string, { review: PullRequestReview; submittedAt: number | null; index: number }>();
  input.reviews.forEach((review, index) => {
    if (review.userType !== undefined && review.userType !== "User") return;
    const reviewer = normalizeReviewer(review.userLogin);
    const submittedAt = parseSubmittedAt(review.submittedAt);
    const latest = latestReviews.get(reviewer);
    if (!latest || isLaterReview({ submittedAt, index }, latest)) {
      latestReviews.set(reviewer, { review, submittedAt, index });
    }
  });

  const approvedReviewers = new Set(
    [...latestReviews.entries()]
      .filter(([, review]) => review.review.state === "APPROVED")
      .map(([reviewer]) => reviewer),
  );
  const requiredApprovalCount = input.requiredApprovalCount ?? input.selectedReviewers.length;
  const missingApprovalCount = Math.max(requiredApprovalCount - approvedReviewers.size, 0);
  const missingReviewers = input.selectedReviewers.filter((reviewer) => {
    const latest = latestReviews.get(normalizeReviewer(reviewer));
    return latest?.review.state !== "APPROVED";
  }).slice(0, missingApprovalCount);

  if (missingApprovalCount === 0) {
    return {
      state: "success",
      summary: "Required human approval count met.",
      missingReviewers: [],
    };
  }

  return {
    state: "in_progress",
    summary:
      missingApprovalCount === 1
        ? "Waiting for 1 more human approval."
        : `Waiting for ${missingApprovalCount} more human approvals.`,
    missingReviewers,
  };
}

function normalizeReviewer(reviewer: string): string {
  return reviewer.replace(/^@/, "").toLowerCase();
}

function isLaterReview(
  candidate: { submittedAt: number | null; index: number },
  current: { submittedAt: number | null; index: number },
): boolean {
  if (candidate.submittedAt === null || current.submittedAt === null) return candidate.index > current.index;
  return candidate.submittedAt > current.submittedAt ||
    (candidate.submittedAt === current.submittedAt && candidate.index > current.index);
}

function parseSubmittedAt(value: string | null): number | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}
