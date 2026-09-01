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
  const persistedOccurredAt = new Date("2026-08-27T09:59:00.000Z");
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
    availability: {
      findActive: vi.fn(async () => []),
    },
    decisions: {
      persistWithEvent: vi.fn(async (input: DecisionInput, event) => {
        const persisted = {
          decisionId: "decision-1",
          actionStatus: input.actionStatus,
          actionError: null,
          actionAppliedAt: null,
        };
        event({ ...persisted, occurredAt: persistedOccurredAt });
        return persisted;
      }),
      markActionSucceeded: vi.fn(async () => {}),
      markActionFailed: vi.fn(async () => {}),
    },
    enqueueReviewPolicy: vi.fn(async () => {}),
    clock: { now: vi.fn(() => new Date("2026-08-27T10:00:00.000Z")) },
  };
}

describe("processChangeRequest", () => {
  it("persists each routing decision and its event through one atomic application port", async () => {
    const baseline = buildPorts();
    const persistedOccurredAt = new Date("2026-08-27T09:58:00.000Z");
    const persistWithEvent = vi.fn(async (input: DecisionInput, event: (persisted: {
      decisionId: string;
      actionStatus: "not_applied" | "pending" | "succeeded" | "failed";
      actionError: string | null;
      actionAppliedAt: Date | null;
      occurredAt: Date;
    }) => unknown) => {
      const persisted = {
        decisionId: "decision-atomic",
        actionStatus: input.actionStatus,
        actionError: null,
        actionAppliedAt: null,
        occurredAt: persistedOccurredAt,
      };
      expect(event(persisted)).toMatchObject({
        schemaVersion: 1,
        eventType: "routing_decision",
        decisionId: "decision-atomic",
        workspaceId: "ws-a",
        provider: "gitlab",
        occurredAt: persistedOccurredAt.toISOString(),
      });
      return persisted;
    });
    const ports = {
      ...baseline,
      decisions: {
        persistWithEvent,
        markActionSucceeded: baseline.decisions.markActionSucceeded,
        markActionFailed: baseline.decisions.markActionFailed,
      },
    } as RoutingApplicationPorts;

    await expect(processChangeRequest(job, ports)).resolves.toEqual({
      status: "decided",
      decisionId: "decision-atomic",
      mode: "shadow",
      actionStatus: "not_applied",
    });
    expect(persistWithEvent).toHaveBeenCalledOnce();
  });

  it("persists invalid configuration and its event through the atomic port", async () => {
    const ports = buildPorts(effectiveConfiguration("version: 1\nmode: observe\n"));
    const persistedOccurredAt = new Date("2026-08-27T09:57:00.000Z");
    let stagedEvent: unknown;
    vi.mocked(ports.decisions.persistWithEvent).mockImplementationOnce(async (input, event) => {
      const persisted = {
        decisionId: "decision-invalid",
        actionStatus: input.actionStatus,
        actionError: null,
        actionAppliedAt: null,
      };
      stagedEvent = event({ ...persisted, occurredAt: persistedOccurredAt });
      return persisted;
    });

    const outcome = await processChangeRequest(job, ports);

    expect(outcome).toEqual({ status: "configuration_failure", decisionId: "decision-invalid" });
    expect(ports.decisions.persistWithEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-a",
        repository: job.changeRequest.repository,
        action: "configuration_failure",
        actionStatus: "not_applied",
        organizationConfigVersion: "org-v3",
        repositoryConfigPath: ".triagepilot.yml",
        repositoryConfigRevision: "base-sha",
        inheritanceMode: "inherit",
        configDiagnostics: expect.arrayContaining([expect.objectContaining({ path: "$.mode" })]),
      }),
      expect.any(Function),
    );
    expect(stagedEvent).toMatchObject({
      eventType: "routing_decision",
      decisionId: "decision-invalid",
      action: "configuration_failure",
      occurredAt: persistedOccurredAt.toISOString(),
    });
    expect(ports.provider.fetchChangeRequestMetadata).not.toHaveBeenCalled();
    expect(ports.provider.applyActions).not.toHaveBeenCalled();
  });

  it("leaves event staging to the atomic port when decision persistence fails", async () => {
    const ports = buildPorts();
    vi.mocked(ports.decisions.persistWithEvent).mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(processChangeRequest(job, ports)).rejects.toThrow("storage unavailable");
  });

  it("skips drafts before provider reads unless configuration includes drafts", async () => {
    const ports = buildPorts(effectiveConfiguration("version: 1\nmode: enforce\n"));

    const outcome = await processChangeRequest({ ...job, isDraft: true }, ports);

    expect(outcome).toEqual({ status: "skipped", reason: "draft" });
    expect(ports.provider.fetchChangeRequestMetadata).not.toHaveBeenCalled();
    expect(ports.decisions.persistWithEvent).not.toHaveBeenCalled();
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
    expect(ports.decisions.persistWithEvent).not.toHaveBeenCalled();
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
    expect(ports.decisions.persistWithEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        riskScore: 100,
        action: "request_human_review",
        selectedActors: ["@user-2e7d4b", "@user-a91f5c"],
        effectiveConfigHash: "effective-hash",
        configSources: { "$.mode": "repository" },
      }),
      expect.any(Function),
    );
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
    expect(ports.decisions.persistWithEvent).toHaveBeenCalledWith(
      expect.objectContaining({ selectedActors: ["@user-a91f5c"] }),
      expect.any(Function),
    );
  });

  it("passes matched owners as the preferred routing tier while retaining fallback capacity", async () => {
    const ports = buildPorts(effectiveConfiguration(`
version: 1
mode: shadow
risk:
  paths:
    - pattern: README.md
      weight: 30
      tag: docs
ownership:
  fallback_reviewers: ["@user-a91f5c"]
  rules:
    - paths: [README.md]
      reviewers: ["@user-2e7d4b"]
`));
    vi.mocked(ports.reviewerLoad).mockResolvedValueOnce({ "@user-2e7d4b": 9, "@user-a91f5c": 0 });

    await processChangeRequest(job, ports);

    expect(ports.reviewerLoad).toHaveBeenCalledWith({
      workspaceId: "ws-a",
      actors: ["@user-2e7d4b", "@user-a91f5c"],
    });
    expect(ports.decisions.persistWithEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedActors: ["@user-2e7d4b"],
        details: expect.objectContaining({
          ownership: expect.objectContaining({ preferredReviewers: ["@user-2e7d4b"] }),
          routing: expect.objectContaining({ requestedReviewerCount: 1, reviewerShortfall: 0 }),
        }),
      }),
      expect.any(Function),
    );
  });

  it("filters both routing tiers at one captured instant before loading available actors", async () => {
    const ports = buildPorts(effectiveConfiguration(`
version: 1
mode: shadow
risk:
  paths:
    - pattern: README.md
      weight: 30
      tag: docs
ownership:
  fallback_reviewers: ["@USER-Fallback"]
  rules:
    - paths: [README.md]
      reviewers: ["@User-Preferred"]
`));
    const evaluatedAt = new Date("2026-10-01T08:00:00.000Z");
    vi.mocked(ports.clock.now).mockReturnValue(evaluatedAt);
    vi.mocked(ports.availability.findActive).mockResolvedValueOnce([{
      externalActorId: "user-preferred",
      startAt: new Date("2026-10-01T07:00:00.000Z"),
      endAt: new Date("2026-10-01T09:00:00.000Z"),
    }]);

    await processChangeRequest(job, ports);

    expect(ports.clock.now).toHaveBeenCalledOnce();
    expect(ports.availability.findActive).toHaveBeenCalledOnce();
    expect(ports.availability.findActive).toHaveBeenCalledWith({
      workspaceId: "ws-a",
      providerConnectionId: "connection-a",
      actors: ["@user-preferred", "@user-fallback"],
      at: evaluatedAt,
    });
    expect(ports.reviewerLoad).toHaveBeenCalledWith({
      workspaceId: "ws-a",
      actors: ["@user-fallback"],
    });
    const availabilityCallOrder = vi.mocked(ports.availability.findActive).mock.invocationCallOrder[0] as number;
    const reviewerLoadCallOrder = vi.mocked(ports.reviewerLoad).mock.invocationCallOrder[0] as number;
    expect(availabilityCallOrder).toBeLessThan(reviewerLoadCallOrder);
    expect(ports.decisions.persistWithEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedActors: ["@user-fallback"],
        details: expect.objectContaining({
          ownership: expect.objectContaining({
            preferredReviewers: ["@User-Preferred"],
            eligibleReviewers: ["@User-Preferred", "@USER-Fallback"],
          }),
          availability: {
            evaluatedAt: "2026-10-01T08:00:00.000Z",
            excludedReviewers: ["@user-preferred"],
          },
        }),
      }),
      expect.any(Function),
    );
  });

  it("keeps active human approvals out of the requested reviewer cohort", async () => {
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

    expect(ports.decisions.persistWithEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedActors: ["@user-a91f5c"],
        details: expect.objectContaining({
          routing: expect.objectContaining({ requestedReviewerCount: 2, reviewerShortfall: 1 }),
        }),
      }),
      expect.any(Function),
    );
    expect(ports.provider.applyActions).toHaveBeenCalledWith(expect.objectContaining({
      selectedActors: ["@user-a91f5c"],
      actorsToRequest: ["@user-a91f5c"],
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
    vi.mocked(ports.decisions.persistWithEvent).mockResolvedValueOnce({
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
