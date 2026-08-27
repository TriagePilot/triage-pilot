import { parseTriagePilotConfig, type EffectiveConfigurationResult } from "@triagepilot/config";
import type { RoutingJobPayload } from "@triagepilot/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  processChangeRequest,
  type DecisionInput,
  type RoutingApplicationPorts,
} from "../src/routing";

const job: RoutingJobPayload = {
  kind: "process_change_request",
  deliveryId: "delivery-1",
  eventName: "change_request.opened",
  workspaceId: "ws-a",
  providerConnectionId: "connection-a",
  changeRequest: {
    repository: { provider: "gitlab", externalId: "200", owner: "acme", name: "api" },
    externalId: "7",
    number: 7,
    baseRevision: "base-sha",
    headRevision: "head-sha",
  },
  isDraft: false,
  routingKey: "routing:ws-a:gitlab:200:7:base-sha:head-sha",
};

function effectiveConfiguration(source: string): EffectiveConfigurationResult {
  const result = parseTriagePilotConfig(source);
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics,
      provenance: {
        organizationVersion: "org-v3",
        repositoryPath: ".triagepilot.yml",
        repositoryRevision: "base-sha",
        inheritanceMode: "inherit",
        effectiveHash: null,
        sources: {},
      },
    };
  }
  return {
    ok: true,
    config: result.config,
    diagnostics: [],
    provenance: {
      organizationVersion: "org-v3",
      repositoryPath: ".triagepilot.yml",
      repositoryRevision: "base-sha",
      inheritanceMode: "inherit",
      effectiveHash: "effective-hash",
      sources: { "$.mode": "repository" },
    },
  };
}

function buildPorts(configuration = effectiveConfiguration("version: 1\nmode: shadow\n")): RoutingApplicationPorts {
  return {
    resolveConfiguration: vi.fn(async () => configuration),
    provider: {
      fetchChangeRequestMetadata: vi.fn(async () => ({
        author: "@user-c91e46",
        sourceBranch: "feature/change",
        targetBranch: "main",
        currentHeadRevision: "head-sha",
      })),
      fetchChangedFiles: vi.fn(async () => [{ path: "README.md", additions: 1, deletions: 0 }]),
      fetchCommitMessages: vi.fn(async () => ["docs: clarify usage"]),
      fetchCurrentRevisionApprovals: vi.fn(async () => []),
      applyActions: vi.fn(async () => {}),
    },
    reviewerLoad: vi.fn<RoutingApplicationPorts["reviewerLoad"]>(
      async ({ actors }) => Object.fromEntries(actors.map((actor) => [actor, 0])),
    ),
    decisions: {
      persist: vi.fn(async (input: DecisionInput) => ({
        decisionId: "decision-1",
        actionStatus: input.actionStatus,
        actionError: null,
        actionAppliedAt: null,
      })),
      markActionSucceeded: vi.fn(async () => {}),
      markActionFailed: vi.fn(async () => {}),
    },
    enqueueReviewPolicy: vi.fn(async () => {}),
    stageDecisionEvent: vi.fn(async () => {}),
    clock: { now: vi.fn(() => new Date("2026-08-27T10:00:00.000Z")) },
  };
}

describe("processChangeRequest", () => {
  it("persists invalid configuration with provenance and stages only after persistence", async () => {
    const ports = buildPorts(effectiveConfiguration("version: 1\nmode: observe\n"));
    const order: string[] = [];
    vi.mocked(ports.decisions.persist).mockImplementationOnce(async (input) => {
      order.push("persist");
      return { decisionId: "decision-invalid", actionStatus: input.actionStatus, actionError: null, actionAppliedAt: null };
    });
    vi.mocked(ports.stageDecisionEvent).mockImplementationOnce(async () => { order.push("stage"); });

    const outcome = await processChangeRequest(job, ports);

    expect(outcome).toEqual({ status: "configuration_failure", decisionId: "decision-invalid" });
    expect(ports.decisions.persist).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-a",
      repository: job.changeRequest.repository,
      action: "configuration_failure",
      actionStatus: "not_applied",
      organizationConfigVersion: "org-v3",
      repositoryConfigPath: ".triagepilot.yml",
      repositoryConfigRevision: "base-sha",
      inheritanceMode: "inherit",
      configDiagnostics: expect.arrayContaining([expect.objectContaining({ path: "$.mode" })]),
    }));
    expect(order).toEqual(["persist", "stage"]);
    expect(ports.provider.fetchChangeRequestMetadata).not.toHaveBeenCalled();
    expect(ports.provider.applyActions).not.toHaveBeenCalled();
  });

  it("does not stage an event when first decision persistence fails", async () => {
    const ports = buildPorts();
    vi.mocked(ports.decisions.persist).mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(processChangeRequest(job, ports)).rejects.toThrow("storage unavailable");

    expect(ports.stageDecisionEvent).not.toHaveBeenCalled();
  });

  it("skips drafts before provider reads unless configuration includes drafts", async () => {
    const ports = buildPorts(effectiveConfiguration("version: 1\nmode: enforce\n"));

    const outcome = await processChangeRequest({ ...job, isDraft: true }, ports);

    expect(outcome).toEqual({ status: "skipped", reason: "draft" });
    expect(ports.provider.fetchChangeRequestMetadata).not.toHaveBeenCalled();
    expect(ports.decisions.persist).not.toHaveBeenCalled();
  });

  it("routes drafts when explicitly configured", async () => {
    const ports = buildPorts(effectiveConfiguration("version: 1\nmode: shadow\nrouting:\n  include_draft_pull_requests: true\n"));

    const outcome = await processChangeRequest({ ...job, isDraft: true }, ports);

    expect(outcome).toEqual({ status: "decided", decisionId: "decision-1", mode: "shadow", actionStatus: "not_applied" });
  });

  it.each([
    {
      name: "target branch",
      source: "version: 1\nmode: enforce\nrouting:\n  exclude_target_branches: [main]\n",
      metadata: { author: "@user-c91e46", sourceBranch: "feature/change", targetBranch: "main", currentHeadRevision: "head-sha" },
      reason: "target_branch" as const,
    },
    {
      name: "source branch pattern",
      source: "version: 1\nmode: enforce\nrouting:\n  exclude_source_branch_patterns: [automated-updates/**]\n",
      metadata: { author: "@user-c91e46", sourceBranch: "automated-updates/pkg", targetBranch: "main", currentHeadRevision: "head-sha" },
      reason: "source_branch" as const,
    },
  ])("skips an excluded $name before diff reads", async ({ source, metadata, reason }) => {
    const ports = buildPorts(effectiveConfiguration(source));
    vi.mocked(ports.provider.fetchChangeRequestMetadata).mockResolvedValueOnce(metadata);

    const outcome = await processChangeRequest(job, ports);

    expect(outcome).toEqual({ status: "skipped", reason });
    expect(ports.provider.fetchChangedFiles).not.toHaveBeenCalled();
    expect(ports.decisions.persist).not.toHaveBeenCalled();
  });

  it("skips a stale revision before scoring or applying actions", async () => {
    const ports = buildPorts(effectiveConfiguration("version: 1\nmode: enforce\n"));
    vi.mocked(ports.provider.fetchChangeRequestMetadata).mockResolvedValueOnce({
      author: "@user-c91e46",
      sourceBranch: "feature/change",
      targetBranch: "main",
      currentHeadRevision: "new-head",
    });

    const outcome = await processChangeRequest(job, ports);

    expect(outcome).toEqual({ status: "skipped", reason: "stale_revision" });
    expect(ports.provider.fetchChangedFiles).not.toHaveBeenCalled();
    expect(ports.provider.applyActions).not.toHaveBeenCalled();
  });

  it("keeps shadow mode write-free while persisting risk, routing, and provenance", async () => {
    const ports = buildPorts(effectiveConfiguration(`
version: 1
mode: shadow
routing:
  high_risk_reviewers: 2
risk:
  paths:
    - pattern: README.md
      weight: 100
      tag: docs
ownership:
  fallback_reviewers: ["@user-a91f5c", "@user-2e7d4b"]
`));

    const outcome = await processChangeRequest(job, ports);

    expect(outcome).toEqual({ status: "decided", decisionId: "decision-1", mode: "shadow", actionStatus: "not_applied" });
    expect(ports.decisions.persist).toHaveBeenCalledWith(expect.objectContaining({
      riskScore: 100,
      action: "request_human_review",
      selectedActors: ["@user-2e7d4b", "@user-a91f5c"],
      effectiveConfigHash: "effective-hash",
      configSources: { "$.mode": "repository" },
    }));
    expect(ports.provider.applyActions).not.toHaveBeenCalled();
    expect(ports.enqueueReviewPolicy).not.toHaveBeenCalled();
  });

  it("uses reviewer load when selecting a medium-risk actor", async () => {
    const ports = buildPorts(effectiveConfiguration(`
version: 1
mode: shadow
risk:
  paths:
    - pattern: README.md
      weight: 30
      tag: docs
ownership:
  fallback_reviewers: ["@user-a91f5c", "@user-2e7d4b"]
`));
    vi.mocked(ports.reviewerLoad).mockResolvedValueOnce({ "@user-a91f5c": 0, "@user-2e7d4b": 5 });

    await processChangeRequest(job, ports);

    expect(ports.reviewerLoad).toHaveBeenCalledWith({ workspaceId: "ws-a", actors: ["@user-a91f5c", "@user-2e7d4b"] });
    expect(ports.decisions.persist).toHaveBeenCalledWith(expect.objectContaining({ selectedActors: ["@user-a91f5c"] }));
  });

  it("credits active human approvals, including approvals that predate routing", async () => {
    const ports = buildPorts(effectiveConfiguration(`
version: 1
mode: enforce
routing:
  high_risk_reviewers: 2
risk:
  paths:
    - pattern: README.md
      weight: 100
      tag: docs
ownership:
  fallback_reviewers: ["@user-a91f5c"]
`));
    vi.mocked(ports.provider.fetchCurrentRevisionApprovals).mockResolvedValueOnce(["@user-4d8a2e", "@user-7c1f9b"]);

    await processChangeRequest(job, ports);

    expect(ports.decisions.persist).toHaveBeenCalledWith(expect.objectContaining({
      selectedActors: ["@user-4d8a2e", "@user-7c1f9b"],
    }));
    expect(ports.provider.applyActions).toHaveBeenCalledWith(expect.objectContaining({
      selectedActors: ["@user-4d8a2e", "@user-7c1f9b"],
      actorsToRequest: [],
    }));
  });

  it("applies enforce actions through a provider-neutral port and durably enqueues policy evaluation", async () => {
    const ports = buildPorts(effectiveConfiguration(`
version: 1
mode: enforce
risk:
  paths:
    - pattern: README.md
      weight: 30
      tag: docs
ownership:
  fallback_reviewers: ["@user-f37a82"]
`));

    const outcome = await processChangeRequest(job, ports);

    expect(ports.provider.applyActions).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-a",
      repository: { provider: "gitlab", externalId: "200", owner: "acme", name: "api" },
      changeRequestId: "7",
      expectedHeadRevision: "head-sha",
    }));
    expect(ports.enqueueReviewPolicy).toHaveBeenCalledWith({
      kind: "evaluate_human_review_policy",
      deliveryId: "routing-policy:delivery-1",
      workspaceId: "ws-a",
      providerConnectionId: "connection-a",
      changeRequest: {
        repository: job.changeRequest.repository,
        externalId: "7",
        number: 7,
      },
    });
    expect(ports.decisions.markActionSucceeded).toHaveBeenCalledWith("decision-1", new Date("2026-08-27T10:00:00.000Z"));
    expect(outcome).toEqual({ status: "decided", decisionId: "decision-1", mode: "enforce", actionStatus: "succeeded" });
  });

  it("does not reapply or re-enqueue an already succeeded decision", async () => {
    const ports = buildPorts(effectiveConfiguration("version: 1\nmode: enforce\n"));
    vi.mocked(ports.decisions.persist).mockResolvedValueOnce({
      decisionId: "decision-1",
      actionStatus: "succeeded",
      actionError: null,
      actionAppliedAt: new Date("2026-08-27T09:00:00.000Z"),
    });

    const outcome = await processChangeRequest(job, ports);

    expect(ports.provider.applyActions).not.toHaveBeenCalled();
    expect(ports.enqueueReviewPolicy).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "decided", decisionId: "decision-1", mode: "enforce", actionStatus: "succeeded" });
  });

  it("marks an action failure with the injected clock and rethrows", async () => {
    const ports = buildPorts(effectiveConfiguration("version: 1\nmode: enforce\n"));
    vi.mocked(ports.provider.applyActions).mockRejectedValueOnce(new Error("provider denied action"));

    await expect(processChangeRequest(job, ports)).rejects.toThrow("provider denied action");

    expect(ports.decisions.markActionFailed).toHaveBeenCalledWith(
      "decision-1",
      "provider denied action",
      new Date("2026-08-27T10:00:00.000Z"),
    );
    expect(ports.enqueueReviewPolicy).not.toHaveBeenCalled();
  });
});
