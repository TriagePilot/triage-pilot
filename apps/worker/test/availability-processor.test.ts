import { describe, expect, it, vi } from "vitest";
import type {
  ReviewerAbsenceActivation,
  ReviewerReplacementCandidate,
} from "@triagepilot/db";

import {
  processReviewerAbsenceActivationJob,
  type ReviewerAvailabilityServices,
} from "../src/availability-processor";

const now = new Date("2026-10-01T08:00:00.000Z");
const message = {
  kind: "activate_reviewer_absence" as const,
  absenceId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 2,
};

const candidate: ReviewerReplacementCandidate = {
  decisionId: "decision-1",
  installationId: "99",
  repositoryId: "101",
  owner: "acme",
  repo: "api",
  pullNumber: 7,
  headSha: "routed-head",
  mode: "enforce",
  selectedReviewers: ["@user-d82a5f"],
  originalEligibleReviewers: ["@user-d82a5f", "@user-c91e46"],
  requiredApprovalCount: 1,
  policyCheckRunId: "check-1",
  policyCheckState: "in_progress",
};

const activation: ReviewerAbsenceActivation = {
  absenceId: message.absenceId,
  revision: message.expectedRevision,
  reviewerHandle: "@user-d82a5f",
  startAt: now,
  endAt: new Date("2026-10-08T08:00:00.000Z"),
  candidates: [candidate],
};

function buildServices(
  overrides: Partial<ReviewerAvailabilityServices> = {},
): ReviewerAvailabilityServices {
  return {
    now: vi.fn(() => now),
    loadActivation: vi.fn(async () => activation),
    findRecordedOutcome: vi.fn(async () => null),
    fetchPullRequest: vi.fn(async () => ({
      state: "open",
      headSha: candidate.headSha,
      authorHandle: "@user-author",
    })),
    fetchReviews: vi.fn(async () => []),
    listAbsenceWindows: vi.fn(async () => []),
    getReviewerLoad: vi.fn(async () => ({ "@user-c91e46": 0 })),
    removeReviewer: vi.fn(async () => {}),
    requestReviewer: vi.fn(async () => {}),
    recordOutcome: vi.fn(async () => ({ inserted: true })),
    reevaluatePolicy: vi.fn(async () => {}),
    failPolicyCheck: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("processReviewerAbsenceActivationJob", () => {
  it.each(["stale", "cancelled", "ended"])("treats a %s activation as a job-level no-op", async () => {
    const services = buildServices({ loadActivation: vi.fn(async () => null) });

    await processReviewerAbsenceActivationJob(message, services);

    expect(services.loadActivation).toHaveBeenCalledWith({
      absenceId: message.absenceId,
      expectedRevision: message.expectedRevision,
      now,
    });
    expect(services.fetchPullRequest).not.toHaveBeenCalled();
    expect(services.recordOutcome).not.toHaveBeenCalled();
  });

  it("records a closed pull request as a decision-scoped skip", async () => {
    const services = buildServices({
      fetchPullRequest: vi.fn(async () => ({
        state: "closed",
        headSha: candidate.headSha,
        authorHandle: "@user-author",
      })),
    });

    await processReviewerAbsenceActivationJob(message, services);

    expect(services.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      absenceId: activation.absenceId,
      absenceRevision: activation.revision,
      decisionId: candidate.decisionId,
      unavailableReviewer: activation.reviewerHandle,
      replacementReviewer: null,
      outcome: "skipped_closed",
      replaceCohort: false,
    }));
    expect(services.fetchReviews).not.toHaveBeenCalled();
    expect(services.removeReviewer).not.toHaveBeenCalled();
  });

  it("records a changed routed head as a decision-scoped skip", async () => {
    const services = buildServices({
      fetchPullRequest: vi.fn(async () => ({
        state: "open",
        headSha: "new-head",
        authorHandle: "@user-author",
      })),
    });

    await processReviewerAbsenceActivationJob(message, services);

    expect(services.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "skipped_changed_head",
      replacementReviewer: null,
      replaceCohort: false,
    }));
    expect(services.fetchReviews).not.toHaveBeenCalled();
    expect(services.removeReviewer).not.toHaveBeenCalled();
  });

  it("uses GitHub-effective approvals without invalidating them by commit ID", async () => {
    const services = buildServices({
      fetchReviews: vi.fn(async () => [{
        userLogin: "user-approved",
        userType: "User",
        state: "APPROVED",
        commitId: "older-head",
        submittedAt: "2026-09-30T10:00:00.000Z",
      }]),
    });

    await processReviewerAbsenceActivationJob(message, services);

    expect(services.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "skipped_policy_satisfied",
      replacementReviewer: null,
      replaceCohort: false,
    }));
    expect(services.reevaluatePolicy).toHaveBeenCalledWith(candidate);
    expect(services.listAbsenceWindows).not.toHaveBeenCalled();
    expect(services.removeReviewer).not.toHaveBeenCalled();
  });

  it("leaves the cohort unchanged when the unavailable reviewer has approved", async () => {
    const approvedCandidate = { ...candidate, requiredApprovalCount: 2 };
    const services = buildServices({
      loadActivation: vi.fn(async () => ({ ...activation, candidates: [approvedCandidate] })),
      fetchReviews: vi.fn(async () => [{
        userLogin: "USER-D82A5F",
        userType: "User",
        state: "APPROVED",
        commitId: "older-head",
        submittedAt: "2026-09-30T10:00:00.000Z",
      }]),
    });

    await processReviewerAbsenceActivationJob(message, services);

    expect(services.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "skipped_approved",
      replacementReviewer: null,
      replaceCohort: false,
    }));
    expect(services.listAbsenceWindows).not.toHaveBeenCalled();
    expect(services.removeReviewer).not.toHaveBeenCalled();
    expect(services.reevaluatePolicy).not.toHaveBeenCalled();
  });

  it("excludes the author, approvals, concurrent absences, and existing cohort before enforcing in order", async () => {
    const events: string[] = [];
    const replacementCandidate: ReviewerReplacementCandidate = {
      ...candidate,
      selectedReviewers: [activation.reviewerHandle, "@user-current"],
      originalEligibleReviewers: [
        activation.reviewerHandle,
        "@user-c91e46",
        "@user-author",
        "@user-approved",
        "@user-absent",
        "@user-current",
      ],
      requiredApprovalCount: 2,
    };
    const services = buildServices({
      loadActivation: vi.fn(async () => ({ ...activation, candidates: [replacementCandidate] })),
      fetchPullRequest: vi.fn(async () => {
        events.push("fetch-pull-request");
        return { state: "open", headSha: candidate.headSha, authorHandle: "@user-author" };
      }),
      fetchReviews: vi.fn(async () => {
        events.push("fetch-reviews");
        return [{
          userLogin: "user-approved",
          userType: "User",
          state: "APPROVED",
          commitId: "older-head",
          submittedAt: "2026-09-30T10:00:00.000Z",
        }];
      }),
      listAbsenceWindows: vi.fn(async () => {
        events.push("list-absence-windows");
        return [{
          reviewerHandle: "@user-absent",
          startAt: now,
          endAt: new Date("2026-10-02T08:00:00.000Z"),
        }];
      }),
      getReviewerLoad: vi.fn(async () => {
        events.push("get-load");
        return { "@user-c91e46": 0 };
      }),
      removeReviewer: vi.fn(async (_candidate, reviewer) => {
        events.push(`remove:${reviewer}`);
      }),
      requestReviewer: vi.fn(async (_candidate, reviewer) => {
        events.push(`request:${reviewer}`);
      }),
      recordOutcome: vi.fn(async (input) => {
        events.push(`persist:${input.outcome}`);
        return { inserted: true };
      }),
      reevaluatePolicy: vi.fn(async () => {
        events.push("reevaluate-policy");
      }),
    });

    await processReviewerAbsenceActivationJob(message, services);

    expect(events).toEqual([
      "fetch-pull-request",
      "fetch-reviews",
      "list-absence-windows",
      "get-load",
      "remove:@user-d82a5f",
      "request:@user-c91e46",
      "persist:replaced",
      "reevaluate-policy",
    ]);
    expect(services.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      replacementReviewer: "@user-c91e46",
      outcome: "replaced",
      replaceCohort: true,
    }));
  });

  it("blocks enforce policy without lowering the cohort when no replacement exists", async () => {
    const events: string[] = [];
    const noReplacementCandidate = {
      ...candidate,
      originalEligibleReviewers: [activation.reviewerHandle],
    };
    const services = buildServices({
      loadActivation: vi.fn(async () => ({ ...activation, candidates: [noReplacementCandidate] })),
      failPolicyCheck: vi.fn(async (_candidate, summary) => {
        events.push(`fail:${summary}`);
      }),
      recordOutcome: vi.fn(async (input) => {
        events.push(`persist:${input.outcome}`);
        return { inserted: true };
      }),
    });

    await processReviewerAbsenceActivationJob(message, services);

    expect(events).toEqual([
      "fail:No replacement is available for an absent required reviewer.",
      "persist:no_replacement_available",
    ]);
    expect(services.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "no_replacement_available",
      replacementReviewer: null,
      reason: "No available reviewer remains in the original ownership-eligible pool.",
      replaceCohort: false,
    }));
    expect(services.removeReviewer).not.toHaveBeenCalled();
    expect(services.requestReviewer).not.toHaveBeenCalled();
    expect(services.reevaluatePolicy).not.toHaveBeenCalled();
  });

  it("records no shadow replacement without failing policy or mutating GitHub", async () => {
    const shadowCandidate = {
      ...candidate,
      mode: "shadow" as const,
      policyCheckState: "not_started" as const,
      originalEligibleReviewers: [activation.reviewerHandle],
    };
    const services = buildServices({
      loadActivation: vi.fn(async () => ({ ...activation, candidates: [shadowCandidate] })),
    });

    await processReviewerAbsenceActivationJob(message, services);

    expect(services.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "no_replacement_available",
      replaceCohort: false,
    }));
    expect(services.removeReviewer).not.toHaveBeenCalled();
    expect(services.requestReviewer).not.toHaveBeenCalled();
    expect(services.reevaluatePolicy).not.toHaveBeenCalled();
    expect(services.failPolicyCheck).not.toHaveBeenCalled();
  });

  it("persists a simulated shadow cohort replacement with zero writes", async () => {
    const shadowCandidate = { ...candidate, mode: "shadow" as const, policyCheckState: "not_started" as const };
    const services = buildServices({
      loadActivation: vi.fn(async () => ({ ...activation, candidates: [shadowCandidate] })),
    });

    await processReviewerAbsenceActivationJob(message, services);

    expect(services.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "simulated_replacement",
      replacementReviewer: "@user-c91e46",
      replaceCohort: true,
    }));
    expect(services.removeReviewer).not.toHaveBeenCalled();
    expect(services.requestReviewer).not.toHaveBeenCalled();
    expect(services.reevaluatePolicy).not.toHaveBeenCalled();
    expect(services.failPolicyCheck).not.toHaveBeenCalled();
  });

  it.each([
    ["replaced", "reevaluate"],
    ["skipped_policy_satisfied", "reevaluate"],
    ["no_replacement_available", "fail"],
    ["permanent_failure", "fail"],
    ["simulated_replacement", "none"],
    ["skipped_approved", "none"],
    ["skipped_closed", "none"],
    ["skipped_changed_head", "none"],
  ] as const)("replays only the %s policy finalizer", async (recordedOutcome, finalizer) => {
    const services = buildServices({
      findRecordedOutcome: vi.fn(async () => recordedOutcome),
    });

    await processReviewerAbsenceActivationJob(message, services);

    expect(services.fetchPullRequest).not.toHaveBeenCalled();
    expect(services.removeReviewer).not.toHaveBeenCalled();
    expect(services.requestReviewer).not.toHaveBeenCalled();
    expect(services.recordOutcome).not.toHaveBeenCalled();
    expect(services.reevaluatePolicy).toHaveBeenCalledTimes(finalizer === "reevaluate" ? 1 : 0);
    expect(services.failPolicyCheck).toHaveBeenCalledTimes(finalizer === "fail" ? 1 : 0);
    if (recordedOutcome === "no_replacement_available") {
      expect(services.failPolicyCheck).toHaveBeenCalledWith(
        candidate,
        "No replacement is available for an absent required reviewer.",
      );
    }
  });

  it("records a permanent GitHub failure, blocks enforce policy, and completes the job", async () => {
    const events: string[] = [];
    const services = buildServices({
      requestReviewer: vi.fn(async () => {
        throw Object.assign(new Error("review request rejected"), { status: 422 });
      }),
      failPolicyCheck: vi.fn(async () => {
        events.push("fail-policy");
      }),
      recordOutcome: vi.fn(async (input) => {
        events.push(`persist:${input.outcome}`);
        return { inserted: true };
      }),
    });

    await expect(processReviewerAbsenceActivationJob(message, services)).resolves.toBeUndefined();

    expect(events).toEqual(["fail-policy", "persist:permanent_failure"]);
    expect(services.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "permanent_failure",
      replacementReviewer: null,
      reason: "review request rejected",
      replaceCohort: false,
    }));
    expect(services.reevaluatePolicy).not.toHaveBeenCalled();
  });

  it("rethrows transient failures for durable job retry", async () => {
    const error = Object.assign(new Error("GitHub unavailable"), { status: 503 });
    const services = buildServices({
      requestReviewer: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(processReviewerAbsenceActivationJob(message, services)).rejects.toBe(error);

    expect(services.failPolicyCheck).not.toHaveBeenCalled();
    expect(services.recordOutcome).not.toHaveBeenCalled();
    expect(services.reevaluatePolicy).not.toHaveBeenCalled();
  });

  it("processes decision candidates sequentially", async () => {
    const secondCandidate = { ...candidate, decisionId: "decision-2", pullNumber: 8 };
    const events: string[] = [];
    const services = buildServices({
      loadActivation: vi.fn(async () => ({ ...activation, candidates: [candidate, secondCandidate] })),
      fetchPullRequest: vi.fn(async (input) => {
        events.push(`fetch:${input.decisionId}`);
        return { state: "closed", headSha: input.headSha, authorHandle: "@user-author" };
      }),
      recordOutcome: vi.fn(async (input) => {
        events.push(`persist:${input.decisionId}`);
        return { inserted: true };
      }),
    });

    await processReviewerAbsenceActivationJob(message, services);

    expect(events).toEqual([
      "fetch:decision-1",
      "persist:decision-1",
      "fetch:decision-2",
      "persist:decision-2",
    ]);
  });
});
