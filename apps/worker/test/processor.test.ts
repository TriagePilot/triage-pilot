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
      authorLogin: "priya",
      authorHandle: "@priya",
      branchName: "docs/usage",
      targetBranchName: "develop",
    })),
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
  fallback_reviewers: ["@sasha"]
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
      authorLogin: "priya",
      authorHandle: "@priya",
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
  exclude_source_branch_patterns: ["dependabot/**"]
`,
    });
    services.fetchPullRequestMetadata.mockResolvedValueOnce({
      authorLogin: "dependabot",
      authorHandle: "@dependabot",
      branchName: "dependabot/npm_and_yarn/vitest-2.1.9",
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
  fallback_reviewers: ["@sasha"]
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

  it("uses a bare author login for AI risk and a handle for reviewer exclusion", async () => {
    const services = buildRoutingServices({
      config: `
version: 1
mode: enforce
risk:
  ai_authorship:
    enabled: true
    modifier: 30
ownership:
  fallback_reviewers: ["@copilot", "@devon"]
`,
    });
    services.fetchPullRequestMetadata.mockResolvedValueOnce({
      authorLogin: "copilot",
      authorHandle: "@copilot",
      branchName: "feature/docs",
      targetBranchName: "develop",
    });

    await processRoutingJob(message, services);

    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "request_human_review",
        riskScore: 35,
        selectedReviewers: ["@devon"],
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
  fallback_reviewers: ["@alpha", "@bravo", "@charlie"]
`,
    });

    await processRoutingJob(message, services);

    expect(services.persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "shadow",
        action: "request_human_review",
        actionStatus: "not_applied",
        selectedReviewers: ["@alpha", "@bravo"],
        details: expect.objectContaining({
          routing: expect.objectContaining({
            requestedReviewerCount: 2,
            selectedReviewers: ["@alpha", "@bravo"],
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
  fallback_reviewers: ["@alpha", "@bravo"]
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
        selectedReviewers: ["@alpha", "@bravo"],
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
