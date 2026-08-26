import { describe, expect, it, vi } from "vitest";

import type { RoutingJobMessage, RoutingJobServices } from "../src/processor";
import { processRoutingJob } from "../src/processor";
import { PermanentJobError } from "../src/errors";

const message: RoutingJobMessage = {
  kind: "process_pull_request",
  deliveryId: "delivery-1",
  installationId: "99",
  repositoryId: "101",
  owner: "acme",
  repo: "api",
  pullNumber: 7,
  baseSha: "trusted-base-123",
  headSha: "abc123",
  eventName: "pull_request.opened",
};

function buildRoutingServices({ config }: { config: string }) {
  return {
    fetchConfig: vi.fn<RoutingJobServices["fetchConfig"]>(async () => config),
    fetchChangedFiles: vi.fn(async () => [{ path: "README.md", additions: 1, deletions: 0 }]),
    fetchCommitMessages: vi.fn(async () => ["docs: clarify usage"]),
    fetchPullRequestMetadata: vi.fn(async () => ({
      authorLogin: "user-c91e46",
      authorHandle: "@user-c91e46",
      branchName: "docs/usage",
      targetBranchName: "develop",
    })),
    fetchActiveApprovedReviewers: vi.fn(async () => []),
    now: vi.fn(() => new Date("2026-10-01T08:00:00.000Z")),
    listReviewerAbsences: vi.fn<RoutingJobServices["listReviewerAbsences"]>(async () => []),
    getReviewerLoad: vi.fn(async ({ reviewers }: { reviewers: string[] }) =>
      Object.fromEntries(reviewers.map((reviewer) => [reviewer, 0])),
    ),
    updateRepositoryConfigState: vi.fn(async () => {}),
    persistDecision: vi.fn(async (input: Parameters<RoutingJobServices["persistDecision"]>[0]) => ({
      decisionId: "decision-1",
      actionStatus: input.actionStatus,
      actionError: null as string | null,
      actionAppliedAt: null as Date | null,
    })),
    applyDecisionActions: vi.fn(async () => {}),
    enqueueHumanReviewPolicyEvaluation: vi.fn(async () => {}),
    markActionSucceeded: vi.fn(async () => {}),
    markActionFailed: vi.fn(async () => {}),
  };
}

describe("processRoutingJob", () => {
  it("cannot let an unmerged head enforce writes when the trusted base remains shadow", async () => {
    const configByRef = {
      "trusted-base-123": "version: 1\nmode: shadow\n",
      abc123: "version: 1\nmode: enforce\n",
    } as const;
    const services = buildRoutingServices({ config: configByRef.abc123 });
    services.fetchConfig.mockImplementationOnce(async (input) =>
      configByRef[input.baseSha as keyof typeof configByRef],
    );

    await processRoutingJob(message, services);

    expect(services.fetchConfig).toHaveBeenCalledWith(message);
    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        pullNumber: 7,
        headSha: "abc123",
        mode: "shadow",
        actionStatus: "not_applied",
      }),
    );
    expect(services.applyDecisionActions).not.toHaveBeenCalled();
  });

  it("stores the intended shadow action without a GitHub write", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: shadow
risk:
  thresholds: { low: 25, high: 70 }
  paths: []
  suppressors: []
  ai_authorship: { enabled: false, modifier: 0 }
ownership:
  rules: []
  fallback_reviewers: ["@user-f37a82"]
`,
    });

    await processRoutingJob(message, services);

    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-1",
        mode: "shadow",
        action: "policy_approval",
        actionStatus: "not_applied",
        details: expect.objectContaining({ pullNumber: 7 }),
      }),
    );
    expect(services.fetchPullRequestMetadata).toHaveBeenCalledWith(message);
    expect(services.updateRepositoryConfigState).toHaveBeenCalledWith({ configState: "valid", mode: "shadow" });
    expect(services.applyDecisionActions).not.toHaveBeenCalled();
  });

  it("excludes absent ownership candidates before loading reviewer capacity", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: shadow
risk:
  paths:
    - pattern: README.md
      weight: 30
      tag: documentation
ownership:
  fallback_reviewers: ["@user-d82a5f", "@user-b4e82d"]
`,
    });
    services.listReviewerAbsences.mockResolvedValueOnce([{
      reviewerHandle: "@user-d82a5f",
      startAt: new Date("2026-10-01T08:00:00.000Z"),
      endAt: new Date("2026-10-08T08:00:00.000Z"),
    }]);

    await processRoutingJob(message, services);

    expect(services.getReviewerLoad).toHaveBeenCalledWith({
      installationId: "99",
      reviewers: ["@user-b4e82d"],
    });
    expect(services.persistDecision).toHaveBeenCalledWith(expect.objectContaining({
      selectedReviewers: ["@user-b4e82d"],
      details: expect.objectContaining({
        ownership: expect.objectContaining({
          eligibleReviewers: ["@user-d82a5f", "@user-b4e82d"],
        }),
        availability: {
          evaluatedAt: "2026-10-01T08:00:00.000Z",
          excludedReviewers: ["@user-d82a5f"],
        },
      }),
    }));
  });

  it("silently skips a pull request targeting an excluded branch", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: enforce
routing:
  exclude_target_branches: ["main"]
`,
    });
    services.fetchPullRequestMetadata.mockResolvedValueOnce({
      authorLogin: "user-c91e46",
      authorHandle: "@user-c91e46",
      branchName: "develop",
      targetBranchName: "main",
    });

    await processRoutingJob(message, services);

    expect(services.updateRepositoryConfigState).toHaveBeenCalledWith({ configState: "valid", mode: "enforce" });
    expect(services.fetchChangedFiles).not.toHaveBeenCalled();
    expect(services.fetchCommitMessages).not.toHaveBeenCalled();
    expect(services.getReviewerLoad).not.toHaveBeenCalled();
    expect(services.persistDecision).not.toHaveBeenCalled();
    expect(services.applyDecisionActions).not.toHaveBeenCalled();
  });

  it("silently skips a pull request from a source branch matching an explicit exclusion pattern", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: enforce
routing:
  exclude_source_branch_patterns: ["automated-updates/**"]
`,
    });
    services.fetchPullRequestMetadata.mockResolvedValueOnce({
      authorLogin: "user-6d3e1a",
      authorHandle: "@user-6d3e1a",
      branchName: "automated-updates/npm_and_yarn/vitest-2.1.9",
      targetBranchName: "main",
    });

    await processRoutingJob(message, services);

    expect(services.updateRepositoryConfigState).toHaveBeenCalledWith({ configState: "valid", mode: "enforce" });
    expect(services.fetchChangedFiles).not.toHaveBeenCalled();
    expect(services.fetchCommitMessages).not.toHaveBeenCalled();
    expect(services.getReviewerLoad).not.toHaveBeenCalled();
    expect(services.persistDecision).not.toHaveBeenCalled();
    expect(services.applyDecisionActions).not.toHaveBeenCalled();
  });

  it("silently skips a draft pull request by default", async () => {
    const services = buildRoutingServices({ config: "version: 1\nmode: enforce\n" });

    await processRoutingJob({ ...message, isDraft: true }, services);

    expect(services.updateRepositoryConfigState).toHaveBeenCalledWith({ configState: "valid", mode: "enforce" });
    expect(services.fetchPullRequestMetadata).not.toHaveBeenCalled();
    expect(services.fetchChangedFiles).not.toHaveBeenCalled();
    expect(services.fetchCommitMessages).not.toHaveBeenCalled();
    expect(services.getReviewerLoad).not.toHaveBeenCalled();
    expect(services.persistDecision).not.toHaveBeenCalled();
    expect(services.applyDecisionActions).not.toHaveBeenCalled();
  });

  it("routes a draft pull request when configuration includes drafts", async () => {
    const services = buildRoutingServices({
      config: "version: 1\nmode: shadow\nrouting:\n  include_draft_pull_requests: true\n",
    });

    await processRoutingJob({ ...message, isDraft: true }, services);

    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({ action: "policy_approval", mode: "shadow" }),
    );
  });

  it("records enforce action success", async () => {
    const services = buildRoutingServices({ config: "version: 1\nmode: enforce\n" });

    await processRoutingJob(message, services);

    expect(services.applyDecisionActions).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "policy_approval",
        decisionId: "decision-1",
        expectedHeadSha: "abc123",
        riskTier: "low",
      }),
    );
    expect(services.persistDecision).toHaveBeenCalledWith(expect.objectContaining({ actionStatus: "pending" }));
    expect(services.markActionSucceeded).toHaveBeenCalledWith("decision-1", expect.any(Date));
  });

  it("schedules a GitHub review evaluation after routing a human-review policy check", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: enforce
risk:
  paths:
    - pattern: README.md
      weight: 30
      tag: docs
ownership:
  fallback_reviewers: ["@user-f37a82"]
`,
    });

    await processRoutingJob(message, services);

    expect(services.enqueueHumanReviewPolicyEvaluation).toHaveBeenCalledWith({
      deliveryId: "routing-policy:delivery-1",
      installationId: "99",
      repositoryId: "101",
      owner: "acme",
      repo: "api",
      pullNumber: 7,
    });
  });

  it("credits active approvals that existed before routing and requests nobody else when they fill a high-risk cohort", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: enforce
routing:
  high_risk_reviewers: 2
risk:
  paths:
    - pattern: README.md
      weight: 100
      tag: documentation
ownership:
  fallback_reviewers: ["@user-0c6e8a"]
`,
    });
    const fetchActiveApprovedReviewers = vi.fn(async () => ["@user-4d8a2e", "@user-7c1f9b"]);
    Object.assign(services, { fetchActiveApprovedReviewers });

    await processRoutingJob(message, services);

    expect(fetchActiveApprovedReviewers).toHaveBeenCalledWith(message);
    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "request_human_review",
        selectedReviewers: ["@user-4d8a2e", "@user-7c1f9b"],
      }),
    );
    expect(services.applyDecisionActions).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedReviewers: ["@user-4d8a2e", "@user-7c1f9b"],
        reviewersToRequest: [],
      }),
    );
  });

  it("does not reapply an enforce action that already succeeded for the delivery", async () => {
    const services = buildRoutingServices({ config: "version: 1\nmode: enforce\n" });
    services.persistDecision.mockResolvedValueOnce({
      decisionId: "decision-1",
      actionStatus: "succeeded",
      actionError: null,
      actionAppliedAt: new Date("2026-08-18T12:00:00.000Z"),
    });

    await processRoutingJob(message, services);

    expect(services.persistDecision).toHaveBeenCalledWith(expect.objectContaining({ actionStatus: "pending" }));
    expect(services.applyDecisionActions).not.toHaveBeenCalled();
    expect(services.markActionSucceeded).not.toHaveBeenCalled();
    expect(services.markActionFailed).not.toHaveBeenCalled();
  });

  it("does not apply a newly calculated action when the delivery already has a terminal success", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: enforce
risk:
  paths:
    - pattern: README.md
      weight: 30
      tag: docs
ownership:
  fallback_reviewers: ["@user-f37a82"]
`,
    });
    services.persistDecision.mockResolvedValueOnce({
      decisionId: "decision-1",
      actionStatus: "succeeded",
      actionError: null,
      actionAppliedAt: new Date("2026-08-18T12:00:00.000Z"),
    });

    await processRoutingJob(message, services);

    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({ action: "request_human_review", actionStatus: "pending" }),
    );
    expect(services.applyDecisionActions).not.toHaveBeenCalled();
    expect(services.markActionSucceeded).not.toHaveBeenCalled();
    expect(services.markActionFailed).not.toHaveBeenCalled();
  });

  it("records enforce action failure before rethrowing it", async () => {
    const services = buildRoutingServices({ config: "version: 1\nmode: enforce\n" });
    services.applyDecisionActions.mockRejectedValueOnce(new Error("GitHub denied the action"));

    await expect(processRoutingJob(message, services)).rejects.toThrow("GitHub denied the action");

    expect(services.markActionFailed).toHaveBeenCalledWith(
      "decision-1",
      "GitHub denied the action",
      expect.any(Date),
    );
    expect(services.markActionSucceeded).not.toHaveBeenCalled();
  });

  it("records a permanent delayed-head failure before rethrowing it", async () => {
    const services = buildRoutingServices({ config: "version: 1\nmode: enforce\n" });
    const error = new PermanentJobError("pull request head changed before enforce actions");
    services.applyDecisionActions.mockRejectedValueOnce(error);

    await expect(processRoutingJob(message, services)).rejects.toBe(error);

    expect(services.applyDecisionActions).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: "abc123" }),
    );
    expect(services.markActionFailed).toHaveBeenCalledWith(
      "decision-1",
      "pull request head changed before enforce actions",
      expect.any(Date),
    );
    expect(services.markActionSucceeded).not.toHaveBeenCalled();
  });

  it("initializes the enforce policy failure without reporting an unavailable reviewer action as applied", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: enforce
risk:
  paths:
    - pattern: README.md
      weight: 30
      tag: docs
`,
    });

    await processRoutingJob(message, services);

    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        pullNumber: 7,
        headSha: "abc123",
        action: "no_eligible_reviewer",
        actionStatus: "not_applied",
      }),
    );
    expect(services.applyDecisionActions).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "no_eligible_reviewer",
        decisionId: "decision-1",
        expectedHeadSha: "abc123",
      }),
    );
    expect(services.markActionSucceeded).not.toHaveBeenCalled();
  });

  it("uses an AI branch signal and excludes the author's handle from reviewers", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: enforce
risk:
  ai_authorship:
    enabled: true
    modifier: 30
ownership:
  fallback_reviewers: ["@user-8b4c20", "@user-b4e82d"]
`,
    });
    services.fetchPullRequestMetadata.mockResolvedValueOnce({
      authorLogin: "user-8b4c20",
      authorHandle: "@user-8b4c20",
      branchName: "codex/fixture-update",
      targetBranchName: "develop",
    });

    await processRoutingJob(message, services);

    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "request_human_review",
        riskScore: 35,
        selectedReviewers: ["@user-b4e82d"],
        details: expect.objectContaining({
          risk: expect.objectContaining({
            components: expect.arrayContaining([expect.objectContaining({ reason: "ai_authorship_signal" })]),
          }),
        }),
      }),
    );
  });

  it("stores two stable reviewers for a high-risk shadow decision without writing to GitHub", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: shadow
routing:
  high_risk_reviewers: 2
risk:
  thresholds: { low: 15, high: 90 }
  paths:
    - pattern: README.md
      weight: 100
      tag: critical
ownership:
  fallback_reviewers: ["@user-a91f5c", "@user-2e7d4b", "@user-c63a18"]
`,
    });

    await processRoutingJob(message, services);

    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "shadow",
        action: "request_human_review",
        actionStatus: "not_applied",
        selectedReviewers: ["@user-2e7d4b", "@user-a91f5c"],
        details: expect.objectContaining({
          routing: expect.objectContaining({
            requestedReviewerCount: 2,
            selectedReviewers: ["@user-2e7d4b", "@user-a91f5c"],
            reviewerShortfall: 0,
          }),
        }),
      }),
    );
    expect(services.applyDecisionActions).not.toHaveBeenCalled();
  });

  it("routes an oversized shadow pull request to two reviewers without writing to GitHub", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: shadow
routing:
  high_risk_reviewers: 2
risk:
  thresholds: { low: 15, high: 90 }
  size: { high_changed_files: 100, high_changed_lines: 5000 }
  paths: []
  suppressors: []
  ai_authorship: { enabled: false, modifier: 0 }
ownership:
  fallback_reviewers: ["@user-a91f5c", "@user-2e7d4b"]
`,
    });
    services.fetchChangedFiles.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, index) => ({ path: `src/file-${index}.ts`, additions: 1, deletions: 0 })),
    );

    await processRoutingJob(message, services);

    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        riskScore: 91,
        action: "request_human_review",
        selectedReviewers: ["@user-2e7d4b", "@user-a91f5c"],
      }),
    );
    expect(services.applyDecisionActions).not.toHaveBeenCalled();
  });

  it("records invalid configuration as a non-writing decision", async () => {
    const services = buildRoutingServices({ config: "version: 1\nmode: observe\n" });

    await processRoutingJob(message, services);

    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-1",
        mode: "shadow",
        action: "configuration_failure",
        actionStatus: "not_applied",
        riskScore: 0,
        details: {
          pullNumber: 7,
          diagnostics: expect.arrayContaining([expect.objectContaining({ path: "$.mode" })]),
        },
      }),
    );
    expect(services.updateRepositoryConfigState).toHaveBeenCalledWith({ configState: "invalid", mode: "shadow" });
    expect(services.fetchChangedFiles).not.toHaveBeenCalled();
    expect(services.fetchCommitMessages).not.toHaveBeenCalled();
    expect(services.fetchPullRequestMetadata).not.toHaveBeenCalled();
    expect(services.applyDecisionActions).not.toHaveBeenCalled();
  });
});
