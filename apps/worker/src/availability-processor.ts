import type {
  RecordReviewerReplacementInput,
  RecordReviewerReplacementResult,
  ReviewerAbsenceActivation,
  ReviewerAbsenceWindow,
  ReviewerReplacementCandidate,
  ReviewerReplacementOutcome,
} from "@triagepilot/db";
import { selectAvailabilityReplacement } from "@triagepilot/core";
import type { PullRequestReview } from "@triagepilot/github";
import type { ReviewerAbsenceActivationJobPayload } from "@triagepilot/shared";

import { classifyWorkerError, PermanentJobError } from "./errors";
import { activeApprovedReviewers } from "./review-policy";

const NO_REPLACEMENT_POLICY_SUMMARY = "No replacement is available for an absent required reviewer.";
const PERMANENT_FAILURE_POLICY_SUMMARY = "Reviewer replacement failed for an absent required reviewer.";

export interface ReviewerAvailabilityServices {
  now(): Date;
  loadActivation(input: {
    absenceId: string;
    expectedRevision: number;
    now: Date;
  }): Promise<ReviewerAbsenceActivation | null>;
  findRecordedOutcome(input: {
    absenceId: string;
    absenceRevision: number;
    decisionId: string;
  }): Promise<ReviewerReplacementOutcome | null>;
  fetchPullRequest(candidate: ReviewerReplacementCandidate): Promise<{
    state: string;
    headSha: string;
    authorHandle: string;
  }>;
  fetchReviews(candidate: ReviewerReplacementCandidate): Promise<PullRequestReview[]>;
  listAbsenceWindows(input: {
    reviewers: string[];
    endingAfter: Date;
  }): Promise<ReviewerAbsenceWindow[]>;
  getReviewerLoad(input: {
    installationId: string;
    reviewers: string[];
  }): Promise<Record<string, number>>;
  removeReviewer(candidate: ReviewerReplacementCandidate, reviewer: string): Promise<void>;
  requestReviewer(candidate: ReviewerReplacementCandidate, reviewer: string): Promise<void>;
  recordOutcome(input: RecordReviewerReplacementInput): Promise<RecordReviewerReplacementResult>;
  reevaluatePolicy(candidate: ReviewerReplacementCandidate): Promise<void>;
  failPolicyCheck(candidate: ReviewerReplacementCandidate, summary: string): Promise<void>;
}

export async function processReviewerAbsenceActivationJob(
  message: ReviewerAbsenceActivationJobPayload,
  services: ReviewerAvailabilityServices,
): Promise<void> {
  const activationAt = services.now();
  const activation = await services.loadActivation({
    absenceId: message.absenceId,
    expectedRevision: message.expectedRevision,
    now: activationAt,
  });
  if (activation === null) return;

  let deferredError: unknown = null;
  for (const candidate of activation.candidates) {
    let recordedOutcome: ReviewerReplacementOutcome | null;
    try {
      recordedOutcome = await services.findRecordedOutcome({
        absenceId: activation.absenceId,
        absenceRevision: activation.revision,
        decisionId: candidate.decisionId,
      });
    } catch (error) {
      if (deferredError === null) deferredError = error;
      continue;
    }

    if (recordedOutcome !== null) {
      if (candidate.mode === "enforce") {
        try {
          await replayPolicyFinalizer(services, candidate, recordedOutcome);
        } catch (error) {
          if (deferredError === null) {
            const classified = classifyWorkerError(error);
            deferredError = classified instanceof PermanentJobError ? classified : error;
          }
        }
      }
      continue;
    }

    try {
      await processCandidate(services, activation, candidate, activationAt);
    } catch (error) {
      const classified = classifyWorkerError(error);
      if (classified instanceof PermanentJobError) {
        const recoveryError = await recoverPermanentFailure(
          services,
          activation,
          candidate,
          activationAt,
          classified,
        );
        if (deferredError === null && recoveryError !== null) deferredError = recoveryError;
      } else if (deferredError === null) {
        deferredError = error;
      }
    }
  }
  if (deferredError !== null) throw deferredError;
}

async function recoverPermanentFailure(
  services: ReviewerAvailabilityServices,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidate,
  activationAt: Date,
  failure: PermanentJobError,
): Promise<unknown | null> {
  try {
    const activationCurrent = await recordOutcome(services, activation, candidate, activationAt, {
      outcome: "permanent_failure",
      replacementReviewer: null,
      reason: failure.message,
      replaceCohort: false,
    });
    if (!activationCurrent) return null;
  } catch (error) {
    return error;
  }

  if (candidate.mode !== "enforce") return null;
  try {
    await services.failPolicyCheck(candidate, PERMANENT_FAILURE_POLICY_SUMMARY);
    return null;
  } catch (error) {
    return classifyWorkerError(error) instanceof PermanentJobError ? null : error;
  }
}

async function processCandidate(
  services: ReviewerAvailabilityServices,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidate,
  activationAt: Date,
): Promise<void> {
  const pullRequest = await services.fetchPullRequest(candidate);
  if (pullRequest.state !== "open") {
    await recordOutcome(services, activation, candidate, activationAt, {
      outcome: "skipped_closed",
      replacementReviewer: null,
      reason: "Pull request is no longer open.",
      replaceCohort: false,
    });
    return;
  }
  if (pullRequest.headSha !== candidate.headSha) {
    await recordOutcome(services, activation, candidate, activationAt, {
      outcome: "skipped_changed_head",
      replacementReviewer: null,
      reason: "Pull request head no longer matches the routed head.",
      replaceCohort: false,
    });
    return;
  }

  const approvedReviewers = activeApprovedReviewers(await services.fetchReviews(candidate));
  if (approvedReviewers.length >= candidate.requiredApprovalCount) {
    const activationCurrent = await recordOutcome(services, activation, candidate, activationAt, {
      outcome: "skipped_policy_satisfied",
      replacementReviewer: null,
      reason: "Required human approval count is already satisfied.",
      replaceCohort: false,
    });
    if (!activationCurrent) return;
    if (candidate.mode === "enforce") await services.reevaluatePolicy(candidate);
    return;
  }
  if (approvedReviewers.map(normalizeReviewer).includes(normalizeReviewer(activation.reviewerHandle))) {
    await recordOutcome(services, activation, candidate, activationAt, {
      outcome: "skipped_approved",
      replacementReviewer: null,
      reason: "Unavailable reviewer has already approved the pull request.",
      replaceCohort: false,
    });
    return;
  }

  const absences = await services.listAbsenceWindows({
    reviewers: candidate.originalEligibleReviewers,
    endingAfter: activationAt,
  });
  const load = await services.getReviewerLoad({
    installationId: candidate.installationId,
    reviewers: candidate.originalEligibleReviewers,
  });
  const selection = selectAvailabilityReplacement({
    originalEligibleReviewers: candidate.originalEligibleReviewers,
    unavailableReviewer: activation.reviewerHandle,
    author: pullRequest.authorHandle,
    approvedReviewers,
    currentReviewers: candidate.selectedReviewers,
    absences,
    now: activationAt,
    load,
    selectionKey: `${candidate.owner}/${candidate.repo}#${candidate.pullNumber}`,
  });
  if (selection.replacementReviewer === null) {
    const activationCurrent = await recordOutcome(services, activation, candidate, activationAt, {
      outcome: "no_replacement_available",
      replacementReviewer: null,
      reason: "No available reviewer remains in the original ownership-eligible pool.",
      replaceCohort: false,
    });
    if (!activationCurrent) return;
    if (candidate.mode === "enforce") {
      await services.failPolicyCheck(candidate, NO_REPLACEMENT_POLICY_SUMMARY);
    }
    return;
  }
  if (candidate.mode === "enforce") {
    await services.removeReviewer(candidate, activation.reviewerHandle);
    await services.requestReviewer(candidate, selection.replacementReviewer);
    const activationCurrent = await recordOutcome(services, activation, candidate, activationAt, {
      outcome: "replaced",
      replacementReviewer: selection.replacementReviewer,
      reason: `Replaced absent reviewer ${activation.reviewerHandle} with ${selection.replacementReviewer}.`,
      replaceCohort: true,
    });
    if (!activationCurrent) return;
    await services.reevaluatePolicy(candidate);
  } else {
    await recordOutcome(services, activation, candidate, activationAt, {
      outcome: "simulated_replacement",
      replacementReviewer: selection.replacementReviewer,
      reason: `Would replace absent reviewer ${activation.reviewerHandle} with ${selection.replacementReviewer}.`,
      replaceCohort: true,
    });
  }
}

async function replayPolicyFinalizer(
  services: ReviewerAvailabilityServices,
  candidate: ReviewerReplacementCandidate,
  outcome: ReviewerReplacementOutcome,
): Promise<void> {
  if (outcome === "replaced" || outcome === "skipped_policy_satisfied") {
    await services.reevaluatePolicy(candidate);
  } else if (outcome === "no_replacement_available") {
    await services.failPolicyCheck(candidate, NO_REPLACEMENT_POLICY_SUMMARY);
  } else if (outcome === "permanent_failure") {
    await services.failPolicyCheck(candidate, PERMANENT_FAILURE_POLICY_SUMMARY);
  }
}

async function recordOutcome(
  services: ReviewerAvailabilityServices,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidate,
  startedAt: Date,
  outcome: Pick<
    RecordReviewerReplacementInput,
    "outcome" | "replacementReviewer" | "reason" | "replaceCohort"
  >,
): Promise<boolean> {
  const result = await services.recordOutcome({
    absenceId: activation.absenceId,
    absenceRevision: activation.revision,
    decisionId: candidate.decisionId,
    unavailableReviewer: activation.reviewerHandle,
    ...outcome,
    startedAt,
    completedAt: services.now(),
  });
  return result.activationCurrent !== false;
}

function normalizeReviewer(reviewer: string): string {
  return reviewer.trim().replace(/^@/, "").toLowerCase();
}
