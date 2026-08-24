import { describe, expect, it, vi } from "vitest";
import type { HumanReviewPolicyDecision } from "@triagepilot/db";

import {
  processHumanReviewPolicyJob,
  type HumanReviewPolicyServices,
} from "../src/review-policy-processor";

const message = {
  kind: "evaluate_human_review_policy" as const,
  deliveryId: "review-delivery-1",
  installationId: "99",
  repositoryId: "101",
  owner: "acme",
  repo: "api",
  pullNumber: 7,
};

const decision: HumanReviewPolicyDecision = {
  decisionId: "decision-1",
  owner: "acme",
  repo: "api",
  pullNumber: 7,
  headSha: "head-2",
  mode: "enforce",
  action: "request_human_review",
  selectedReviewers: ["@alice", "@bob"],
  policyCheckRunId: "71",
  policyCheckState: "in_progress",
};

function buildServices(): HumanReviewPolicyServices {
  return {
    findDecision: vi.fn(async () => decision),
    fetchPullRequest: vi.fn(async () => ({ state: "open", headSha: "head-2" })),
    fetchReviews: vi.fn(async () => []),
    updateCheck: vi.fn(async () => {}),
    persistState: vi.fn(async () => {}),
  };
}

describe("processHumanReviewPolicyJob", () => {
  it("skips without a write when there is no matching enforce decision", async () => {
    const services = buildServices();
    vi.mocked(services.findDecision).mockResolvedValueOnce(null);

    await processHumanReviewPolicyJob(message, services);

    expect(services.fetchPullRequest).not.toHaveBeenCalled();
    expect(services.fetchReviews).not.toHaveBeenCalled();
    expect(services.updateCheck).not.toHaveBeenCalled();
    expect(services.persistState).not.toHaveBeenCalled();
  });

  it("keeps the stored check in progress while one approval is missing", async () => {
    const services = buildServices();
    vi.mocked(services.fetchReviews).mockResolvedValueOnce([
      {
        userLogin: "alice",
        state: "APPROVED",
        commitId: "head-2",
        submittedAt: "2026-08-21T10:00:00Z",
      },
    ]);

    await processHumanReviewPolicyJob(message, services);

    expect(services.updateCheck).toHaveBeenCalledWith({
      decision,
      state: "in_progress",
      summary: "Waiting for approval from @bob.",
    });
    expect(services.persistState).toHaveBeenCalledWith({
      decisionId: "decision-1",
      state: "in_progress",
    });
    expect(services.fetchPullRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses to complete the old check when the head changes after evaluation", async () => {
    const services = buildServices();
    vi.mocked(services.fetchPullRequest)
      .mockResolvedValueOnce({ state: "open", headSha: "head-2" })
      .mockResolvedValueOnce({ state: "open", headSha: "head-3" });
    vi.mocked(services.fetchReviews).mockResolvedValueOnce([
      {
        userLogin: "alice",
        state: "APPROVED",
        commitId: "head-2",
        submittedAt: "2026-08-21T10:00:00Z",
      },
      {
        userLogin: "bob",
        state: "APPROVED",
        commitId: "head-2",
        submittedAt: "2026-08-21T11:00:00Z",
      },
    ]);

    await processHumanReviewPolicyJob(message, services);

    expect(services.fetchPullRequest).toHaveBeenCalledTimes(2);
    expect(services.updateCheck).not.toHaveBeenCalled();
    expect(services.persistState).not.toHaveBeenCalled();
  });

  it("writes and persists success after rechecking the open matching head", async () => {
    const services = buildServices();
    vi.mocked(services.fetchReviews).mockResolvedValueOnce([
      {
        userLogin: "alice",
        state: "APPROVED",
        commitId: "head-2",
        submittedAt: "2026-08-21T10:00:00Z",
      },
      {
        userLogin: "bob",
        state: "APPROVED",
        commitId: "head-2",
        submittedAt: "2026-08-21T11:00:00Z",
      },
    ]);

    await processHumanReviewPolicyJob(message, services);

    expect(services.fetchPullRequest).toHaveBeenCalledTimes(2);
    expect(services.updateCheck).toHaveBeenCalledWith({
      decision,
      state: "success",
      summary: "All required human reviewers approved the current head.",
    });
    expect(services.persistState).toHaveBeenCalledWith({
      decisionId: "decision-1",
      state: "success",
    });
    expect(vi.mocked(services.fetchPullRequest).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(services.updateCheck).mock.invocationCallOrder[0] as number,
    );
    expect(vi.mocked(services.updateCheck).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(services.persistState).mock.invocationCallOrder[0] as number,
    );
  });

  it("keeps a terminal failure sticky when later reviews would produce success", async () => {
    const services = buildServices();
    vi.mocked(services.findDecision).mockResolvedValueOnce({ ...decision, policyCheckState: "failure" });
    vi.mocked(services.fetchReviews).mockResolvedValueOnce([
      {
        userLogin: "alice",
        state: "APPROVED",
        commitId: "head-2",
        submittedAt: "2026-08-21T10:00:00Z",
      },
      {
        userLogin: "bob",
        state: "APPROVED",
        commitId: "head-2",
        submittedAt: "2026-08-21T11:00:00Z",
      },
    ]);

    await processHumanReviewPolicyJob(message, services);

    expect(services.fetchPullRequest).not.toHaveBeenCalled();
    expect(services.fetchReviews).not.toHaveBeenCalled();
    expect(services.updateCheck).not.toHaveBeenCalled();
    expect(services.persistState).not.toHaveBeenCalled();
  });

  it("keeps a terminal failure sticky when later reviews would return to waiting", async () => {
    const services = buildServices();
    vi.mocked(services.findDecision).mockResolvedValueOnce({ ...decision, policyCheckState: "failure" });

    await processHumanReviewPolicyJob(message, services);

    expect(services.fetchPullRequest).not.toHaveBeenCalled();
    expect(services.fetchReviews).not.toHaveBeenCalled();
    expect(services.updateCheck).not.toHaveBeenCalled();
    expect(services.persistState).not.toHaveBeenCalled();
  });

  it("keeps an existing no-eligible-reviewer failure terminal", async () => {
    const services = buildServices();
    const noEligibleDecision: HumanReviewPolicyDecision = {
      ...decision,
      action: "no_eligible_reviewer",
      selectedReviewers: [],
      policyCheckState: "failure",
    };
    vi.mocked(services.findDecision).mockResolvedValueOnce(noEligibleDecision);

    await processHumanReviewPolicyJob(message, services);

    expect(services.fetchPullRequest).not.toHaveBeenCalled();
    expect(services.fetchReviews).not.toHaveBeenCalled();
    expect(services.updateCheck).not.toHaveBeenCalled();
    expect(services.persistState).not.toHaveBeenCalled();
  });

  it.each([
    ["a closed pull request", { state: "closed", headSha: "head-2" }],
    ["an obsolete decision head", { state: "open", headSha: "head-3" }],
  ])("skips %s", async (_caseName, pullRequest) => {
    const services = buildServices();
    vi.mocked(services.fetchPullRequest).mockResolvedValueOnce(pullRequest);

    await processHumanReviewPolicyJob(message, services);

    expect(services.fetchReviews).not.toHaveBeenCalled();
    expect(services.updateCheck).not.toHaveBeenCalled();
    expect(services.persistState).not.toHaveBeenCalled();
  });
});
