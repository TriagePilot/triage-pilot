import { describe, expect, it, vi } from "vitest";
import { processChangeRequest, type ReviewPolicyDecision } from "@triagepilot/application";
import { parseTriagePilotConfig } from "@triagepilot/config";
import type { HumanReviewPolicyDecision } from "@triagepilot/db";

import {
  createWorkerHumanReviewPolicyServiceFactory,
  createWorkerReviewerAvailabilityServiceFactory,
  createWorkerRoutingServiceFactory,
} from "../src/runtime-services";
import { PermanentJobError } from "../src/errors";
import type { RoutingJobMessage } from "../src/processor";
import { processHumanReviewPolicyJob } from "../src/review-policy-processor";

const message: RoutingJobMessage = {
  kind: "process_change_request",
  deliveryId: "delivery-1",
  eventName: "change_request.opened",
  workspaceId: "ws_local",
  providerConnectionId: "99",
  changeRequest: {
    repository: { provider: "github", externalId: "101", owner: "acme", name: "api" },
    externalId: "7",
    number: 7,
    baseRevision: "trusted-base-123",
    headRevision: "unmerged-head-456",
  },
  isDraft: false,
  routingKey: "routing:ws_local:github:101:7:trusted-base-123:unmerged-head-456",
};

const policyMessage = {
  kind: "evaluate_human_review_policy" as const,
  deliveryId: "review-delivery-1",
  workspaceId: "ws_local",
  providerConnectionId: "99",
  changeRequest: {
    repository: { provider: "github" as const, externalId: "101", owner: "acme", name: "api" },
    externalId: "7",
    number: 7,
  },
};

const availabilityMessage = {
  kind: "activate_reviewer_absence" as const,
  workspaceId: "ws_local",
  provider: "github" as const,
  providerConnectionId: "99",
  absenceId: "absence-1",
  absenceRevision: 2,
};

describe("worker reviewer availability runtime scope", () => {
  it("preserves durable selection context when mapping loaded replacement records", async () => {
    const selectionContext = {
      status: "complete" as const, source: "tracked_github_pending" as const,
      observedAt: "2026-09-01T09:59:00.000Z", trackedSince: "2026-06-03T09:59:00.000Z",
      loads: { replacement: 3 }, reason: null,
    };
    const row = {
      id: "replacement-1", workspace_id: availabilityMessage.workspaceId, provider: "github",
      provider_connection_id: availabilityMessage.providerConnectionId,
      absence_id: availabilityMessage.absenceId, absence_revision: availabilityMessage.absenceRevision,
      decision_id: "decision-1", unavailable_actor_id: "absent", replacement_actor_id: "replacement",
      mutation_intent_id: "intent-1", outcome: "replaced", state: "finalizer_pending",
      last_error: null, selection_context: selectionContext,
    };
    const query = {
      selectAll: () => query, where: () => query, orderBy: () => query,
      execute: async () => [row], executeTakeFirst: async () => row,
    };
    const services = createWorkerReviewerAvailabilityServiceFactory({
      db: { selectFrom: () => query } as never,
      credentialProvider: { getCredential: vi.fn(async () => { throw new Error("unused"); }) },
    })(availabilityMessage);
    expect((await services.availability.loadReplacement(row.id))?.selectionContext).toEqual(selectionContext);
    expect((await services.availability.listPendingFinalizers({
      absenceId: availabilityMessage.absenceId, absenceRevision: availabilityMessage.absenceRevision,
    }))[0]?.selectionContext).toEqual(selectionContext);
  });

  it("rejects a wrong workspace before database, adapter, or credential composition", async () => {
    const database = knownRepositoryDatabase();
    const selectFrom = vi.spyOn(database, "selectFrom");
    const getCredential = vi.fn(async () => { throw new Error("credentials must not be read"); });
    const createAdapter = vi.fn(() => { throw new Error("adapter must not be composed"); });
    const services = createWorkerReviewerAvailabilityServiceFactory({
      db: database as never,
      credentialProvider: { getCredential },
      createAdapter,
    })(availabilityMessage);

    await expect(services.provider.inspectChangeRequest({
      workspaceId: "ws-other",
      providerConnectionId: "99",
      repository: { provider: "github", externalId: "101", owner: "acme", name: "api" },
      changeRequestId: "7",
      changeRequestNumber: 7,
    })).rejects.toThrow("reviewer availability target scope does not match claimed job");

    expect(selectFrom).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("rejects an unsupported claimed provider before database or credential access", () => {
    const database = knownRepositoryDatabase();
    const selectFrom = vi.spyOn(database, "selectFrom");
    const getCredential = vi.fn(async () => { throw new Error("credentials must not be read"); });

    expect(() => createWorkerReviewerAvailabilityServiceFactory({
      db: database as never,
      credentialProvider: { getCredential },
    })({ ...availabilityMessage, provider: "gitlab" })).toThrow(
      "reviewer availability provider is not configured: gitlab",
    );
    expect(selectFrom).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
  });

  it("rejects malformed claimed scope before database, adapter, or credential composition", () => {
    const database = knownRepositoryDatabase();
    const selectFrom = vi.spyOn(database, "selectFrom");
    const getCredential = vi.fn(async () => { throw new Error("credentials must not be read"); });
    const createAdapter = vi.fn(() => { throw new Error("adapter must not be composed"); });

    expect(() => createWorkerReviewerAvailabilityServiceFactory({
      db: database as never,
      credentialProvider: { getCredential },
      createAdapter,
    })({ ...availabilityMessage, absenceId: " " })).toThrow(
      "reviewer absence activation job scope is malformed",
    );
    expect(selectFrom).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
  });
});

describe("worker routing GitHub reads", () => {
  it("invalidates an accepted reviewer request when the later policy enqueue fails", async () => {
    const invalidate = vi.fn();
    const request = actionRequester("unmerged-head-456");
    const services = createWorkerRoutingServiceFactory({ db: knownRepositoryDatabase() as never, github: { appId: "123", privateKey: "key" }, createRequester: async () => ({ request }), reviewerBacklog: { readLoad: vi.fn(), readCurrent: vi.fn(), invalidate } })(message);
    const parsed = parseTriagePilotConfig('version: 1\nmode: enforce\nrisk:\n  paths:\n    - pattern: README.md\n      weight: 50\n      tag: docs\nownership:\n  fallback_reviewers: ["@reviewer"]\n');
    if (!parsed.ok) throw new Error("invalid fixture");
    services.resolveConfiguration = async () => ({ ok: true, config: parsed.config, diagnostics: [], provenance: { organizationVersion: null, repositoryPath: ".triagepilot.yml", repositoryRevision: "base", inheritanceMode: "inherit", effectiveHash: "hash", sources: {} } });
    services.availability.findActive = async () => [];
    services.decisions.findCompleted = async () => null;
    services.decisions.persistWithEvent = async () => ({ decisionId: "decision-1", actionStatus: "pending", actionError: null, actionAppliedAt: null });
    services.decisions.markActionFailed = vi.fn();
    services.provider.fetchChangeRequestMetadata = async () => ({ author: "@author", sourceBranch: "feature", targetBranch: "main", currentHeadRevision: "unmerged-head-456" });
    services.provider.fetchChangedFiles = async () => [{ path: "README.md", additions: 1, deletions: 0 }];
    services.provider.fetchCommitMessages = async () => [];
    services.provider.fetchCurrentRevisionApprovals = async () => [];
    services.reviewerBacklog = async () => ({ status: "complete", source: "tracked_github_pending", observedAt: new Date().toISOString(), trackedSince: new Date().toISOString(), loads: { "@reviewer": 0 }, reason: null });
    services.enqueueReviewPolicy = async () => { throw new Error("later policy enqueue failed"); };
    await expect(processChangeRequest(message, services)).rejects.toThrow("later policy enqueue failed");
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", expect.objectContaining({ reviewers: ["reviewer"] }));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(services.decisions.markActionFailed).toHaveBeenCalled();
  });

  it.each(["accepted", "timeout", "read-failure"])("invalidates precisely at reviewer mutation attempts: %s", async outcome => {
    const invalidate = vi.fn();
    const base = actionRequester("unmerged-head-456");
    const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (outcome === "read-failure" && route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") throw new Error("read failed");
      if (outcome === "timeout" && route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") throw new Error("unknown request result timeout");
      return base(route, parameters);
    });
    const services = createWorkerRoutingServiceFactory({ db: knownRepositoryDatabase() as never, github: { appId: "123", privateKey: "key" }, createRequester: async () => ({ request }), reviewerBacklog: { readLoad: vi.fn(), readCurrent: vi.fn(), invalidate } })(message);
    const attempt = services.applyDecisionActions({ action: "request_human_review", expectedHeadSha: "unmerged-head-456", decisionId: "decision-1", riskTier: "medium", selectedReviewers: ["@reviewer"], reviewersToRequest: ["@reviewer"] });
    if (outcome === "accepted") await attempt;
    else await expect(attempt).rejects.toThrow(outcome === "timeout" ? "timeout" : "read failed");
    expect(invalidate).toHaveBeenCalledTimes(outcome === "read-failure" ? 0 : 1);
  });

  it("exposes a provider-neutral availability port without provider reads", async () => {
    const request = vi.fn(async () => {
      throw new Error("availability lookup must not use the provider");
    });
    const services = buildServices(message, request);
    const at = new Date("2026-10-01T08:00:00.000Z");

    await expect(services.availability.findActive({
      workspaceId: "ws_local",
      providerConnectionId: "99",
      actors: [],
      at,
    })).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a wrong-workspace availability lookup before repository or provider access", async () => {
    const request = vi.fn(async () => {
      throw new Error("scope rejection must not use the provider");
    });
    const database = knownRepositoryDatabase();
    const selectFrom = vi.spyOn(database, "selectFrom");
    const services = buildServices(message, request, database);

    await expect(services.availability.findActive({
      workspaceId: "ws-other",
      providerConnectionId: "99",
      actors: ["Actor:Preferred/7"],
      at: new Date("2026-10-01T08:00:00.000Z"),
    })).rejects.toEqual(new Error("availability lookup scope does not match routing job"));
    expect(selectFrom).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a wrong-provider-connection availability lookup before repository or provider access", async () => {
    const request = vi.fn(async () => {
      throw new Error("scope rejection must not use the provider");
    });
    const database = knownRepositoryDatabase();
    const selectFrom = vi.spyOn(database, "selectFrom");
    const services = buildServices(message, request, database);

    await expect(services.availability.findActive({
      workspaceId: "ws_local",
      providerConnectionId: "connection-other",
      actors: ["Actor:Preferred/7"],
      at: new Date("2026-10-01T08:00:00.000Z"),
    })).rejects.toEqual(new Error("availability lookup scope does not match routing job"));
    expect(selectFrom).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not expose a compatibility path that persists a decision without its event", () => {
    const services = buildServices(message, configRequester());

    expect(services).not.toHaveProperty("persistDecision");
  });

  it("paginates changed files while preserving GitHub response order", async () => {
    const firstPage = [
      { filename: "src/first.ts", additions: 1, deletions: 0 },
      ...Array.from({ length: 98 }, () => ({ filename: "src/middle.ts", additions: 0, deletions: 0 })),
      { filename: "src/last.ts", additions: 2, deletions: 1 },
    ];
    const request = vi.fn(async (_route: string, parameters: Record<string, unknown>) => ({
      data: parameters.page === 1
        ? firstPage
        : [
            { filename: "src/after-first-page.ts", additions: 3, deletions: 0 },
            { filename: "src/after-last.ts", additions: 4, deletions: 2 },
          ],
    }));
    const services = buildServices(message, request);

    await expect(services.fetchChangedFiles(message)).resolves.toEqual([
      { path: "src/first.ts", additions: 1, deletions: 0 },
      ...Array.from({ length: 98 }, () => ({ path: "src/middle.ts", additions: 0, deletions: 0 })),
      { path: "src/last.ts", additions: 2, deletions: 1 },
      { path: "src/after-first-page.ts", additions: 3, deletions: 0 },
      { path: "src/after-last.ts", additions: 4, deletions: 2 },
    ]);
    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner: "acme", repo: "api", pull_number: 7, page: 1, per_page: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner: "acme", repo: "api", pull_number: 7, page: 2, per_page: 100,
    });
  });

  it("reads repository configuration from the trusted base SHA without PR metadata lookup", async () => {
    const request = configRequester();
    const services = buildServices(message, request);

    await expect(services.fetchConfig(message)).resolves.toBe("version: 1\nmode: shadow\n");

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: "acme",
      repo: "api",
      path: ".triagepilot.yml",
      ref: "trusted-base-123",
    });
  });

  it("resolves a legacy queued payload through the current PR base and never the head SHA", async () => {
    const request = configRequester();
    const legacyMessage: RoutingJobMessage = {
      ...message,
      changeRequest: { ...message.changeRequest, baseRevision: "" },
    };
    const services = buildServices(legacyMessage, request);

    await expect(services.fetchConfig(legacyMessage)).resolves.toBe("version: 1\nmode: shadow\n");

    expect(request.mock.calls).toEqual([
      ["GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: "acme",
        repo: "api",
        pull_number: 7,
      }],
      ["GET /repos/{owner}/{repo}/contents/{path}", {
        owner: "acme",
        repo: "api",
        path: ".triagepilot.yml",
        ref: "trusted-base-123",
      }],
    ]);
  });

  it("credits active human approvals from earlier heads before routing", async () => {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
        return {
          data: [
            {
              user: { login: "user-d82a5f", type: "User" },
              state: "APPROVED",
              commit_id: "previous-head-123",
              submitted_at: "2026-08-26T10:00:00Z",
            },
            {
              user: { login: "user-f30c8a", type: "User" },
              state: "APPROVED",
              commit_id: "previous-head-123",
              submitted_at: "2026-08-26T10:00:00Z",
            },
            {
              user: { login: "user-f30c8a", type: "User" },
              state: "CHANGES_REQUESTED",
              commit_id: "unmerged-head-456",
              submitted_at: "2026-08-26T11:00:00Z",
            },
            {
              user: { login: "automation-bot", type: "Bot" },
              state: "APPROVED",
              commit_id: "previous-head-123",
              submitted_at: "2026-08-26T10:00:00Z",
            },
          ],
        };
      }
      throw new Error(`Unexpected request: ${route}`);
    });
    const services = buildServices(message, request);

    await expect(services.fetchActiveApprovedReviewers(message)).resolves.toEqual(["@user-d82a5f"]);
  });

  it("blocks every enforce write when a delayed job no longer matches the current PR head", async () => {
    const request = actionRequester("advanced-head-789");
    const services = buildServices(message, request);

    await expect(
      services.applyDecisionActions({
        action: "policy_approval",
        decisionId: "decision-1",
        expectedHeadSha: "unmerged-head-456",
        riskTier: "low",
      }),
    ).rejects.toEqual(new PermanentJobError("pull request head changed before enforce actions"));

    expect(request.mock.calls).toEqual([
      ["GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: "acme",
        repo: "api",
        pull_number: 7,
      }],
    ]);
  });

  it("applies enforce writes after a fresh matching head check", async () => {
    const request = actionRequester("unmerged-head-456");
    const services = buildServices(message, request);

    const action = {
      action: "policy_approval",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      riskTier: "low",
      risk: {
        score: 40,
        classifierVersion: "risk-v3",
        components: [
          { reason: "changed_file_count", score: 10, detail: "10 changed files" },
          { reason: "high_risk_path:auth", score: 30, detail: "1 file matched src/auth/**" },
          { reason: "author_rule:review", score: 30, detail: "PR author @alex matched author rule" },
        ],
      },
    } as Parameters<typeof services.applyDecisionActions>[0];

    await services.applyDecisionActions(action);

    expect(request.mock.calls[0]).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner: "acme", repo: "api", pull_number: 7 },
    ]);
    expect(request.mock.calls.filter(([route]) => route.startsWith("POST ")).map(([route]) => route)).toEqual([
      "POST /repos/{owner}/{repo}/check-runs",
      "POST /repos/{owner}/{repo}/check-runs",
      "POST /repos/{owner}/{repo}/labels",
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    ]);
    expect(request.mock.calls.find(
      ([route, parameters]) =>
        route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy",
    )).toEqual([
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        name: "triagepilot/human-review-policy",
        head_sha: "unmerged-head-456",
        external_id: "decision-1",
        status: "completed",
        conclusion: "success",
        output: expect.objectContaining({ summary: "No human approval is required for this pull request." }),
      }),
    ]);
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      expect.objectContaining({ commit_id: "unmerged-head-456" }),
    );
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: "acme",
      repo: "api",
      issue_number: 7,
      body: "<!-- triagepilot:decision:decision-1 -->\nTriagePilot decision: policy_approval\n\n**Risk score:** 40/100 · **Tier:** low\n**Classifier:** risk-v3\n\n<details>\n<summary>Score breakdown</summary>\n\n- **+10 Changed file count** — 10 changed files\n- **+30 High-risk path: auth** — 1 file matched src/auth/**\n- **+30 Author rule: review** — PR author @alex matched author rule\n</details>",
    });
  });

  it("syncs the calculated risk label during an enforce action", async () => {
    const request = actionRequester("unmerged-head-456");
    const services = buildServices(message, request);

    await services.applyDecisionActions({
      action: "request_human_review",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      riskTier: "high",
      selectedReviewers: ["@user-d82a5f"],
    });

    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      owner: "acme",
      repo: "api",
      issue_number: 7,
      labels: ["triagepilot:risk-high"],
    });
  });

  it("creates an in-progress policy check before requesting selected reviewers", async () => {
    const request = actionRequester("unmerged-head-456");
    const services = buildServices(message, request);

    await services.applyDecisionActions({
      action: "request_human_review",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      riskTier: "medium" as const,
      selectedReviewers: ["@user-d82a5f"],
    });

    const policyCheckCall = request.mock.calls.findIndex(
      ([route, parameters]) => route.endsWith("/check-runs") && parameters.name === "triagepilot/human-review-policy",
    );
    const reviewerRequestCall = request.mock.calls.findIndex(([route]) => route.includes("requested_reviewers"));
    expect(policyCheckCall).toBeGreaterThan(0);
    expect(policyCheckCall).toBeLessThan(reviewerRequestCall);
    expect(request.mock.calls[policyCheckCall]?.[1]).toEqual(
      expect.objectContaining({ status: "in_progress" }),
    );
    expect(request.mock.calls[policyCheckCall]?.[1]).not.toHaveProperty("conclusion");
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      expect.objectContaining({ reviewers: ["user-d82a5f"], team_reviewers: [] }),
    );
    expect(request.mock.calls.filter(([route]) => route.includes("requested_reviewers"))).toHaveLength(1);
  });

  it("creates a failed policy check without requesting reviewers when nobody is eligible", async () => {
    const request = actionRequester("unmerged-head-456");
    const services = buildServices(message, request);

    await services.applyDecisionActions({
      action: "no_eligible_reviewer",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      riskTier: "medium" as const,
    });

    expect(request.mock.calls[0]?.[0]).toBe("GET /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        name: "triagepilot/human-review-policy",
        status: "completed",
        conclusion: "failure",
      }),
    );
    expect(request.mock.calls.some(([route]) => route.includes("requested_reviewers"))).toBe(false);
    expect(request.mock.calls.some(([route]) => route.endsWith("/reviews") && route.startsWith("POST "))).toBe(false);
  });

  it("reuses the recorded policy check for a retried decision on the same head", async () => {
    const request = actionRequester("unmerged-head-456");
    const services = buildServices(message, request, knownRepositoryDatabase("71"));

    await services.applyDecisionActions({
      action: "request_human_review",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      riskTier: "medium",
      selectedReviewers: ["@user-d82a5f"],
    });

    expect(
      request.mock.calls.filter(
        ([route, parameters]) =>
          route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy",
      ),
    ).toHaveLength(0);
    expect(request.mock.calls.filter(([route]) => route.includes("requested_reviewers"))).toHaveLength(1);
  });

  it("recovers a decision-keyed policy check after GitHub create succeeds but DB recording fails", async () => {
    const request = recoverablePolicyCheckRequester();
    const db = policyStateDatabase({ failFirstRecord: true });
    const services = buildServices(message, request, db);
    const action = {
      action: "request_human_review",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      riskTier: "medium" as const,
      selectedReviewers: ["@user-d82a5f"],
    };

    await expect(services.applyDecisionActions(action)).rejects.toThrow("database record failed");
    await services.applyDecisionActions(action);

    expect(
      request.mock.calls.filter(
        ([route, parameters]) =>
          route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy",
      ),
    ).toHaveLength(1);
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "in_progress" });
  });

  it("replaces a completed success check when an approval is withdrawn on the same head", async () => {
    const request = replacementPolicyRequester();
    const db = policyStateDatabase({ checkRunId: "71", state: "success" });
    const services = buildPolicyServices(request, db);
    const decision = humanReviewDecision({ policyCheckRunId: "71", policyCheckState: "success" });

    await processHumanReviewPolicyJob(policyMessage, {
      ...services,
      decisions: {
        ...services.decisions,
        findLatest: async () => applicationDecision(decision),
      },
    });

    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        external_id: "decision-1",
        status: "in_progress",
        output: expect.objectContaining({ summary: "Waiting for 1 more human approval." }),
      }),
    );
    expect(db.policyCheck()).toEqual({ checkRunId: "72", state: "in_progress" });
  });

  it("reconciles remote success when DB success persistence failed before a later withdrawal", async () => {
    const request = stalePersistencePolicyRequester();
    const db = policyStateDatabase({
      checkRunId: "71",
      state: "in_progress",
      failFirstStatePersist: true,
    });
    const services = buildPolicyServices(request, db);
    const staleDecision = humanReviewDecision({ policyCheckRunId: "71", policyCheckState: "in_progress" });
    const processingServices = {
      ...services,
      decisions: {
        ...services.decisions,
        findLatest: async () => applicationDecision(staleDecision),
      },
    };

    await expect(processHumanReviewPolicyJob(policyMessage, processingServices)).rejects.toThrow(
      "database state persistence failed",
    );
    expect(request.remoteCheck()).toEqual({ checkRunId: "71", state: "success" });
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "in_progress" });

    request.withdrawApproval();
    await processHumanReviewPolicyJob(policyMessage, processingServices);

    expect(request.remoteCheck()).toEqual({ checkRunId: "72", state: "in_progress" });
    expect(db.policyCheck()).toEqual({ checkRunId: "72", state: "in_progress" });
    expect(
      request.mock.calls.filter(
        ([route, parameters]) =>
          route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["informational check", "routing_check", "request_human_review"],
    ["routing comment", "comment", "request_human_review"],
    ["reviewer request", "reviewer", "request_human_review"],
    ["policy approval", "approval", "policy_approval"],
  ] as const)("fails the policy check when the later %s write fails permanently", async (_name, failurePoint, action) => {
    const request = permanentlyFailingActionRequester(failurePoint);
    const db = policyStateDatabase();
    const services = buildServices(message, request, db);

    await expect(
      services.applyDecisionActions({
        action,
        decisionId: "decision-1",
        expectedHeadSha: "unmerged-head-456",
        riskTier: action === "policy_approval" ? "low" : "medium",
        ...(action === "request_human_review" ? { selectedReviewers: ["@user-d82a5f"] } : {}),
      }),
    ).rejects.toMatchObject({ status: 422 });

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        check_run_id: "71",
        conclusion: "failure",
        output: expect.objectContaining({ summary: expect.stringContaining("routing action failed") }),
      }),
    );
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "failure" });
  });

  it("fails the recorded policy run when a transient downstream error exhausts retries", async () => {
    const request = transientlyFailingActionRequester();
    const db = policyStateDatabase({ checkRunId: "71", state: "in_progress" });
    const services = buildServices(message, request, db);
    const action = {
      action: "request_human_review",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      riskTier: "medium" as const,
      selectedReviewers: ["@user-d82a5f"],
    };

    await expect(services.applyDecisionActions(action)).rejects.toMatchObject({ status: 503 });
    await services.failPolicyCheck?.(
      "TriagePilot routing action failed after 5 attempts: GitHub temporarily unavailable",
    );

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        check_run_id: "71",
        conclusion: "failure",
        output: expect.objectContaining({ summary: expect.stringContaining("after 5 attempts") }),
      }),
    );
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "failure" });
  });

  it("recovers the exact delivery decision when policy finalization runs in a fresh service", async () => {
    const request = transientlyFailingActionRequester();
    const db = policyStateDatabase({ checkRunId: "71", state: "in_progress" });
    const recoveredServices = buildServices(message, request, db);

    await recoveredServices.failPolicyCheck?.(
      "TriagePilot routing action failed after 5 attempts: GitHub temporarily unavailable",
    );

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({ check_run_id: "71", conclusion: "failure" }),
    );
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "failure" });
  });

  it("wires policy-event reads and terminal updates through one installation requester", async () => {
    const request = policyRequester();
    const createRequester = vi.fn(async () => ({ request })) as never;
    const services = createWorkerHumanReviewPolicyServiceFactory({
      db: knownRepositoryDatabase() as never,
      github: { appId: "123", privateKey: "test-private-key" },
      createRequester,
    })(policyMessage);
    const decision: HumanReviewPolicyDecision = {
      decisionId: "decision-1",
      owner: "acme",
      repo: "api",
      pullNumber: 7,
      headSha: "unmerged-head-456",
      mode: "enforce",
      action: "request_human_review",
      selectedReviewers: ["@user-d82a5f"],
      policyCheckRunId: "71",
      policyCheckState: "in_progress",
    };

    await expect(services.fetchPullRequest({} as never)).resolves.toEqual({
      state: "open",
      headSha: "unmerged-head-456",
    });
    await expect(services.fetchReviews({} as never)).resolves.toEqual([
      {
        userLogin: "user-d82a5f",
        state: "APPROVED",
        commitId: "unmerged-head-456",
        submittedAt: "2026-08-21T10:00:00Z",
      },
    ]);
    await services.updateCheck({ decision, state: "success", summary: "Approved." });

    expect(createRequester).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({ check_run_id: "71", conclusion: "success" }),
    );
  });

  it("finalizes the stored evaluation policy check through a fresh installation requester", async () => {
    const request = policyRequester();
    const db = evaluationPolicyDatabase();
    const services = buildPolicyServices(request, db);

    await services.failPolicyCheck?.(
      "TriagePilot human-review policy evaluation failed: permission denied",
      "decision-1",
    );

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        check_run_id: "71",
        conclusion: "failure",
        output: expect.objectContaining({ summary: expect.stringContaining("evaluation failed") }),
      }),
    );
    expect(db.policyCheckState()).toBe("failure");
  });

  it("reconciles a remotely failed check before a later approval after failure persistence was interrupted", async () => {
    const request = partialStateRaceRequester({ initialState: "in_progress", reviewState: "APPROVED" });
    const db = evaluationPolicyDatabase({ failFirstRecord: true });
    const services = buildPolicyServices(request, db);

    await expect(services.failPolicyCheck?.(
      "TriagePilot human-review policy evaluation failed: permission denied",
      "decision-1",
    )).rejects.toThrow("database record failed");
    expect(request.runs()).toEqual([{ checkRunId: "71", state: "failure" }]);
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "in_progress" });

    await expect(processHumanReviewPolicyJob(policyMessage, services)).rejects.toEqual(
      new PermanentJobError("human-review policy check is already failed"),
    );

    expect(request.runs()).toEqual([{ checkRunId: "71", state: "failure" }]);
    expect(request.mock.calls.filter(
      ([route, parameters]) => route.startsWith("PATCH ") && parameters.conclusion === "success",
    )).toHaveLength(0);
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "failure" });
  });

  it("finalizes the newest replacement check after its DB recording was interrupted", async () => {
    const request = partialStateRaceRequester({ initialState: "success", reviewState: "CHANGES_REQUESTED" });
    const db = evaluationPolicyDatabase({ initialState: "success", failFirstRecord: true });
    const services = buildPolicyServices(request, db);

    await expect(processHumanReviewPolicyJob(policyMessage, services)).rejects.toThrow("database record failed");
    expect(request.runs()).toEqual([
      { checkRunId: "71", state: "success" },
      { checkRunId: "72", state: "in_progress" },
    ]);
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "success" });

    await services.failPolicyCheck?.(
      "TriagePilot human-review policy evaluation failed: permission denied",
      "decision-1",
    );

    expect(request.runs()).toEqual([
      { checkRunId: "71", state: "success" },
      { checkRunId: "72", state: "failure" },
    ]);
    expect(request.mock.calls.filter(
      ([route, parameters]) => route.startsWith("PATCH ") && parameters.check_run_id === "71",
    )).toHaveLength(0);
    expect(db.policyCheck()).toEqual({ checkRunId: "72", state: "failure" });
  });
});

function configRequester() {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return {
        data: {
          base: { sha: "trusted-base-123", ref: "main" },
          draft: false,
          state: "open",
          head: { sha: "unmerged-head-456", ref: "unsafe-policy-change" },
          user: { login: "user-c91e46" },
        },
      };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      const source = parameters.ref === "trusted-base-123"
        ? "version: 1\nmode: shadow\n"
        : "version: 1\nmode: enforce\n";
      return { data: { content: Buffer.from(source).toString("base64") } };
    }
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function actionRequester(currentHeadSha: string) {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return {
        data: {
          base: { sha: "trusted-base-123", ref: "main" },
          draft: false,
          state: "open",
          head: { sha: currentHeadSha, ref: "feature" },
          user: { login: "user-c91e46" },
        },
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return { data: { check_runs: [] } };
    }
    if (
      route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments" ||
      route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels" ||
      route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
    ) {
      return { data: [] };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy") {
      return { data: { id: 71 } };
    }
    if (route.startsWith("POST ")) return { data: {} };
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function policyRequester() {
  return vi.fn(async (route: string) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
      return {
        data: [{
          user: { login: "user-d82a5f" },
          state: "APPROVED",
          commit_id: "unmerged-head-456",
          submitted_at: "2026-08-21T10:00:00Z",
        }],
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return {
        data: {
          check_runs: [{
            id: 71,
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: "in_progress",
            conclusion: null,
            app: { id: 123 },
          }],
        },
      };
    }
    if (route.startsWith("PATCH ")) return { data: {} };
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function partialStateRaceRequester(input: {
  initialState: "in_progress" | "success";
  reviewState: "APPROVED" | "CHANGES_REQUESTED";
}) {
  const runs: Array<{ checkRunId: string; state: "in_progress" | "success" | "failure" }> = [{
    checkRunId: "71",
    state: input.initialState,
  }];
  const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
      return {
        data: [{
          user: { login: "user-d82a5f" },
          state: input.reviewState,
          commit_id: "unmerged-head-456",
          submitted_at: "2026-08-21T11:00:00Z",
        }],
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return {
        data: {
          check_runs: runs.map((run) => ({
            id: Number(run.checkRunId),
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: run.state === "in_progress" ? "in_progress" : "completed",
            conclusion: run.state === "in_progress" ? null : run.state,
            app: { id: 123 },
          })),
        },
      };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs") {
      runs.push({ checkRunId: "72", state: "in_progress" });
      return { data: { id: 72 } };
    }
    if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
      const run = runs.find(({ checkRunId }) => checkRunId === String(parameters.check_run_id));
      if (!run) throw new Error(`unknown check run ${String(parameters.check_run_id)}`);
      run.state = String(parameters.conclusion) as "success" | "failure";
      return { data: {} };
    }
    throw new Error(`unexpected GitHub route: ${route}`);
  });
  return Object.assign(request, {
    runs: () => runs.map((run) => ({ ...run })),
  });
}

function recoverablePolicyCheckRequester() {
  let created = false;
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", draft: false, base: { sha: "trusted-base-123", ref: "main" }, head: { sha: "unmerged-head-456", ref: "feature" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      if (parameters.check_name === "triagepilot/human-review-policy") {
        return {
          data: {
            check_runs: created
              ? [{
                  id: 71,
                  name: "triagepilot/human-review-policy",
                  external_id: "decision-1",
                  status: "in_progress",
                  conclusion: null,
                  app: { id: 123 },
                }]
              : [],
          },
        };
      }
      return { data: { check_runs: [] } };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy") {
      created = true;
      return { data: { id: 71 } };
    }
    if (
      route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments" ||
      route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels" ||
      route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
    ) return { data: [] };
    if (route.startsWith("POST ")) return { data: {} };
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function replacementPolicyRequester() {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
      return {
        data: [{
          user: { login: "user-d82a5f" },
          state: "CHANGES_REQUESTED",
          commit_id: "unmerged-head-456",
          submitted_at: "2026-08-21T11:00:00Z",
        }],
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return {
        data: {
          check_runs: [{
            id: 71,
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: "completed",
            conclusion: "success",
            app: { id: 123 },
          }],
        },
      };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy") {
      return { data: { id: 72 } };
    }
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function stalePersistencePolicyRequester() {
  let approvalWithdrawn = false;
  let remoteCheck = { checkRunId: "71", state: "in_progress" as "in_progress" | "success" | "failure" };
  const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
      return {
        data: [{
          user: { login: "user-d82a5f" },
          state: approvalWithdrawn ? "CHANGES_REQUESTED" : "APPROVED",
          commit_id: "unmerged-head-456",
          submitted_at: approvalWithdrawn ? "2026-08-21T12:00:00Z" : "2026-08-21T11:00:00Z",
        }],
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return {
        data: {
          check_runs: [{
            id: Number(remoteCheck.checkRunId),
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: remoteCheck.state === "in_progress" ? "in_progress" : "completed",
            conclusion: remoteCheck.state === "in_progress" ? null : remoteCheck.state,
            app: { id: 123 },
          }],
        },
      };
    }
    if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
      remoteCheck = { checkRunId: String(parameters.check_run_id), state: String(parameters.conclusion) as "success" };
      return { data: {} };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs") {
      remoteCheck = { checkRunId: "72", state: "in_progress" };
      return { data: { id: 72 } };
    }
    throw new Error(`unexpected GitHub route: ${route}`);
  });
  return Object.assign(request, {
    withdrawApproval() {
      approvalWithdrawn = true;
    },
    remoteCheck() {
      return remoteCheck;
    },
  });
}

function permanentlyFailingActionRequester(failurePoint: "routing_check" | "comment" | "reviewer" | "approval") {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", draft: false, base: { sha: "trusted-base-123", ref: "main" }, head: { sha: "unmerged-head-456", ref: "feature" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      if (parameters.check_name === "triagepilot/human-review-policy") return { data: { check_runs: [] } };
      if (failurePoint === "routing_check") throw Object.assign(new Error("routing check denied"), { status: 422 });
      return { data: { check_runs: [] } };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy") {
      return { data: { id: 71 } };
    }
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
      if (failurePoint === "comment") throw Object.assign(new Error("comment denied"), { status: 422 });
      return { data: [] };
    }
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") return { data: [] };
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data: [] };
    if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers" && failurePoint === "reviewer") {
      throw Object.assign(new Error("reviewer request denied"), { status: 422 });
    }
    if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews" && failurePoint === "approval") {
      throw Object.assign(new Error("approval denied"), { status: 422 });
    }
    if (route.startsWith("PATCH ") || route.startsWith("POST ")) return { data: {} };
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function transientlyFailingActionRequester() {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", draft: false, base: { sha: "trusted-base-123", ref: "main" }, head: { sha: "unmerged-head-456", ref: "feature" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") return { data: { check_runs: [] } };
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") return { data: [] };
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") return { data: [] };
    if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
      throw Object.assign(new Error("GitHub temporarily unavailable"), { status: 503 });
    }
    if (route.startsWith("PATCH ") || route.startsWith("POST ")) return { data: {} };
    throw new Error(`unexpected GitHub route: ${route} ${JSON.stringify(parameters)}`);
  });
}

function humanReviewDecision(
  overrides: Partial<HumanReviewPolicyDecision> = {},
): HumanReviewPolicyDecision {
  return {
    decisionId: "decision-1",
    owner: "acme",
    repo: "api",
    pullNumber: 7,
    headSha: "unmerged-head-456",
    mode: "enforce",
    action: "request_human_review",
    selectedReviewers: ["@user-d82a5f"],
    policyCheckRunId: "71",
    policyCheckState: "in_progress",
    ...overrides,
  };
}

function applicationDecision(decision: HumanReviewPolicyDecision): ReviewPolicyDecision {
  return {
    decisionId: decision.decisionId,
    workspaceId: policyMessage.workspaceId,
    repository: policyMessage.changeRequest.repository,
    changeRequestId: policyMessage.changeRequest.externalId,
    changeRequestNumber: decision.pullNumber,
    headRevision: decision.headSha,
    mode: decision.mode,
    action: decision.action,
    selectedActors: decision.selectedReviewers,
    ...(decision.requiredApprovalCount === undefined ? {} : { requiredApprovalCount: decision.requiredApprovalCount }),
    policyCheckRunId: decision.policyCheckRunId,
    policyCheckState: decision.policyCheckState,
  };
}

function policyStateDatabase(input: {
  checkRunId?: string;
  state?: "in_progress" | "success" | "failure";
  failFirstRecord?: boolean;
  failFirstStatePersist?: boolean;
} = {}) {
  let policyCheck = input.checkRunId
    ? { checkRunId: input.checkRunId, state: input.state ?? "in_progress" }
    : null;
  let failRecord = input.failFirstRecord ?? false;
  let failStatePersist = input.failFirstStatePersist ?? false;
  return {
    selectFrom: (table: string) => table === "routing_decisions"
      ? {
          select: (columns: string[]) => ({
            where: () => ({
              executeTakeFirst: async () => columns.includes("id as decisionId")
                ? { decisionId: "decision-1", headSha: "unmerged-head-456" }
                : policyCheck
                  ? { checkRunId: policyCheck.checkRunId, headSha: "unmerged-head-456" }
                  : undefined,
            }),
          }),
        }
      : ({
          innerJoin: () => ({
            select: () => ({
              where: () => ({
                where: () => ({
                  where: () => ({ executeTakeFirst: async () => ({ repositoryId: "repository-row-1", externalConnectionId: "123" }) }),
                }),
              }),
            }),
          }),
        }),
    updateTable: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          execute: async () => {
            if ("policy_check_run_id" in values) {
              if (failRecord) {
                failRecord = false;
                throw new Error("database record failed");
              }
              policyCheck = {
                checkRunId: String(values.policy_check_run_id),
                state: values.policy_check_state as "in_progress" | "success" | "failure",
              };
            } else if ("policy_check_state" in values && policyCheck) {
              if (failStatePersist) {
                failStatePersist = false;
                throw new Error("database state persistence failed");
              }
              policyCheck.state = values.policy_check_state as "in_progress" | "success" | "failure";
            }
          },
        }),
      }),
    }),
    policyCheck: () => policyCheck,
  };
}

function buildPolicyServices(
  request: { (route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }> },
  db: unknown = policyStateDatabase(),
) {
  return createWorkerHumanReviewPolicyServiceFactory({
    db: db as never,
    github: { appId: "123", privateKey: "test-private-key" },
    createRequester: vi.fn(async () => ({ request })) as never,
  })(policyMessage);
}

function knownRepositoryDatabase(recordedCheckRunId?: string) {
  const updateQuery = { where: () => updateQuery, execute: async () => [] };
  return {
    selectFrom: (table: string) => table === "routing_decisions"
      ? {
          select: () => ({
            where: () => ({
              executeTakeFirst: async () => recordedCheckRunId
                ? { checkRunId: recordedCheckRunId, headSha: "unmerged-head-456" }
                : undefined,
            }),
          }),
        }
      : ({
          innerJoin: () => ({
            select: () => ({
              where: () => ({
                where: () => ({
                  where: () => ({
                    executeTakeFirst: async () => ({ repositoryId: "repository-row-1", externalConnectionId: "123" }),
                  }),
                }),
              }),
            }),
          }),
        }),
    updateTable: () => ({
      set: () => updateQuery,
    }),
  };
}

function evaluationPolicyDatabase(input: {
  initialState?: "in_progress" | "success" | "failure";
  failFirstRecord?: boolean;
} = {}) {
  let policyCheck = { checkRunId: "71", state: input.initialState ?? "in_progress" };
  let failRecord = input.failFirstRecord ?? false;
  return {
    selectFrom: (table: string) => table === "routing_decisions"
      ? {
          select: () => ({
            where: () => ({
              executeTakeFirst: async () => ({
                decisionId: "decision-1",
                repositoryId: "repository-row-1",
                pullNumber: 7,
                headSha: "unmerged-head-456",
                mode: "enforce",
                policyCheckRunId: policyCheck.checkRunId,
                policyCheckState: policyCheck.state,
              }),
            }),
          }),
          innerJoin: () => ({
            select: () => ({
              where: () => ({
                where: () => ({
                  orderBy: () => ({
                    executeTakeFirst: async () => ({
                      decisionId: "decision-1",
                      owner: "acme",
                      repo: "api",
                      pullNumber: 7,
                      headSha: "unmerged-head-456",
                      mode: "enforce",
                      action: "request_human_review",
                      selectedReviewers: ["@user-d82a5f"],
                      policyCheckRunId: policyCheck.checkRunId,
                      policyCheckState: policyCheck.state,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }
      : ({
          innerJoin: () => ({
            select: () => ({
              where: () => ({
                where: () => ({
                  where: () => ({ executeTakeFirst: async () => ({ repositoryId: "repository-row-1", externalConnectionId: "123" }) }),
                }),
              }),
            }),
          }),
        }),
    updateTable: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          execute: async () => {
            if ("policy_check_run_id" in values) {
              if (failRecord) {
                failRecord = false;
                throw new Error("database record failed");
              }
              policyCheck = {
                checkRunId: String(values.policy_check_run_id),
                state: String(values.policy_check_state) as "in_progress" | "success" | "failure",
              };
            } else if ("policy_check_state" in values) {
              policyCheck.state = String(values.policy_check_state) as "in_progress" | "success" | "failure";
            }
          },
        }),
      }),
    }),
    policyCheckState: () => policyCheck.state,
    policyCheck: () => ({ ...policyCheck }),
  };
}

function buildServices(
  messageInput: RoutingJobMessage,
  request: { (route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }> },
  db: unknown = knownRepositoryDatabase(),
) {
  return createWorkerRoutingServiceFactory({
    db: db as never,
    github: { appId: "123", privateKey: "test-private-key" },
    createRequester: vi.fn(async () => ({ request })) as never,
  })(messageInput);
}

describe("branch exclusion GitHub actions", () => {
  const branchExclusion = { type: "target_branch" as const, branch: "main", matchingRule: "main" };
  function ignoredAction() {
    return { workspaceId: message.workspaceId, providerConnectionId: message.providerConnectionId, repository: message.changeRequest.repository, changeRequestId: "7", changeRequestNumber: 7, expectedHeadRevision: message.changeRequest.headRevision, decisionId: "ignored-1", action: "policy_approval" as const, risk: null, branchExclusion, expectedBranches: { source: "feature", target: "main" }, expectedBaseRevision: "trusted-base-123", selectedActors: [], actorsToRequest: [], noHumanReason: 'Branch exclusion: target branch "main" matches "main". Risk not evaluated.' };
  }
  function rerouteDatabase() {
    const queued: Record<string, unknown>[] = [];
    const db = { ...knownRepositoryDatabase(), insertInto: () => ({ values: (row: Record<string, unknown>) => {
      queued.push(row);
      return { onConflict: () => ({ returning: () => ({ executeTakeFirst: async () => ({ id: "reroute-job" }) }) }) };
    } }) };
    return { db, queued };
  }

  it("rejects a closed pull request before any exclusion writes", async () => {
    const base = actionRequester(message.changeRequest.headRevision);
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      const response = await base(route, params);
      return route === "GET /repos/{owner}/{repo}/pulls/{pull_number}"
        ? { data: { ...response.data, state: "closed" } } : response;
    });
    await expect(buildServices(message, request).provider.applyActions(ignoredAction())).rejects.toThrow("not open");
    expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
  });

  it.each([false, true])("reroutes a changed draft state (previously draft: %s) before exclusion writes", async isDraft => {
    const base = actionRequester(message.changeRequest.headRevision);
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      const response = await base(route, params);
      return route === "GET /repos/{owner}/{repo}/pulls/{pull_number}"
        ? { data: { ...response.data, draft: !isDraft } } : response;
    });
    const { db, queued } = rerouteDatabase();
    await expect(buildServices({ ...message, isDraft }, request, db).provider.applyActions(ignoredAction())).rejects.toThrow("routing context changed");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ payload: { isDraft: !isDraft } });
    expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
  });

  it.each([
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    "POST /repos/{owner}/{repo}/check-runs",
    "GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
    "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
    "POST /repos/{owner}/{repo}/labels",
    "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
  ])("stops obsolete exclusion writes when retargeted after %s", async after => {
    const base = actionRequester(message.changeRequest.headRevision);
    let changed = false;
    const writesAfterChange: string[] = [];
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (changed && !route.startsWith("GET ")) writesAfterChange.push(route);
      const response = route.startsWith("DELETE ") ? { data: {} } : await base(route, params);
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return { data: { ...response.data, base: { sha: "trusted-base-123", ref: changed ? "release" : "main" } } };
      }
      if (route === after) changed = true;
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") return { data: [{ name: "triagepilot:risk-high" }] };
      return response;
    });
    const { db, queued } = rerouteDatabase();
    await expect(buildServices(message, request, db).provider.applyActions(ignoredAction())).rejects.toThrow("routing context changed");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ payload: { changeRequest: { targetBranch: "release" } } });
    expect(writesAfterChange).toEqual([]);
  });

  it.each(["closed", "draft", "base", "head"])("stops approval if the PR changes to %s during the review lookup", async change => {
    const base = actionRequester(message.changeRequest.headRevision);
    let changed = false;
    const writesAfterChange: string[] = [];
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (changed && !route.startsWith("GET ")) writesAfterChange.push(route);
      const response = await base(route, params);
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}" && changed) {
        return { data: { ...response.data, state: change === "closed" ? "closed" : "open", draft: change === "draft",
          base: { sha: change === "base" ? "new-base" : "trusted-base-123", ref: "main" },
          head: { sha: change === "head" ? "new-head" : message.changeRequest.headRevision, ref: "feature" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") changed = true;
      return response;
    });
    const { db, queued } = rerouteDatabase();
    await expect(buildServices(message, request, db).provider.applyActions(ignoredAction())).rejects.toThrow(
      change === "closed" ? "not open" : change === "head" ? "head changed" : "routing context changed",
    );
    expect(queued).toHaveLength(change === "base" || change === "draft" ? 1 : 0);
    expect(writesAfterChange).toEqual([]);
  });

  it("reroutes a signed job with unchanged branches when its base SHA advances", async () => {
    const request = vi.fn(async () => ({ data: { state: "open", draft: false,
      head: { sha: message.changeRequest.headRevision, ref: "feature" }, base: { sha: "new-base", ref: "main" } } }));
    const { db, queued } = rerouteDatabase();
    const signedJob = { ...message, changeRequest: { ...message.changeRequest, sourceBranch: "feature", targetBranch: "main" } };
    await expect(buildServices(signedJob, request, db).provider.fetchChangeRequestMetadata(signedJob)).rejects.toThrow("routing context changed");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ payload: { changeRequest: { baseRevision: "new-base" } } });
  });

  it("reroutes a scored action when its trusted base changes after metadata acquisition", async () => {
    const base = actionRequester(message.changeRequest.headRevision);
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      const response = await base(route, params);
      return route === "GET /repos/{owner}/{repo}/pulls/{pull_number}"
        ? { data: { ...response.data, base: { sha: "new-base", ref: "main" } } } : response;
    });
    const { db, queued } = rerouteDatabase();
    await expect(buildServices(message, request, db).applyDecisionActions({
      action: "policy_approval", expectedHeadSha: message.changeRequest.headRevision, decisionId: "scored-1", riskTier: "low",
    })).rejects.toThrow("routing context changed");
    expect(queued).toHaveLength(1);
    expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
  });

  it("retains the resolved base revision for legacy jobs without a signed base SHA", async () => {
    let changed = false;
    const base = configRequester();
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      const response = await base(route, params);
      return route === "GET /repos/{owner}/{repo}/pulls/{pull_number}" && changed
        ? { data: { ...response.data, base: { sha: "new-base", ref: "main" } } } : response;
    });
    const { db, queued } = rerouteDatabase();
    const legacyJob = { ...message, changeRequest: { ...message.changeRequest, baseRevision: "" } };
    const services = buildServices(legacyJob, request, db);
    await services.resolveConfiguration(legacyJob);
    changed = true;
    await expect(services.applyDecisionActions({
      action: "policy_approval", expectedHeadSha: message.changeRequest.headRevision, decisionId: "legacy-1", riskTier: "low",
    })).rejects.toThrow("routing context changed");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ payload: { changeRequest: { baseRevision: "new-base" } } });
    expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
  });
  it("approves the validated head and publishes the ignored label and successful checks without comments", async () => {
    const request = actionRequester(message.changeRequest.headRevision);
    const services = buildServices(message, request);
    await services.provider.applyActions(ignoredAction());
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/labels", expect.objectContaining({ name: "triagepilot:ignored" }));
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", expect.objectContaining({ labels: ["triagepilot:ignored"] }));
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", expect.objectContaining({ commit_id: "unmerged-head-456", event: "APPROVE" }));
    for (const name of ["triagepilot/human-review-policy", "triagepilot/routing"]) {
      expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/check-runs", expect.objectContaining({ name, head_sha: "unmerged-head-456", status: "completed", conclusion: "success" }));
    }
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/check-runs", expect.objectContaining({ name: "triagepilot/routing", output: expect.objectContaining({ summary: ignoredAction().noHumanReason }) }));
    expect(request.mock.calls.some(([route]) => route.includes("comments") || route.includes("requested_reviewers"))).toBe(false);
  });
  it.each([
    { name: "target", liveTarget: "release", liveSource: "feature", liveBase: "trusted-base-123", sourceExclusion: false },
    { name: "source", liveTarget: "main", liveSource: "changed-source", liveBase: "trusted-base-123", sourceExclusion: true },
    { name: "source exclusion after retarget", liveTarget: "release", liveSource: "feature", liveBase: "trusted-base-123", sourceExclusion: true },
    { name: "trusted configuration", liveTarget: "main", liveSource: "feature", liveBase: "new-base-789", sourceExclusion: false },
  ])("reroutes a changed $name before any exclusion approval writes", async ({ liveTarget, liveSource, liveBase, sourceExclusion }) => {
    const base = actionRequester(message.changeRequest.headRevision);
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { state: "open", draft: false, head: { sha: message.changeRequest.headRevision, ref: liveSource }, base: { sha: liveBase, ref: liveTarget } } };
      return base(route, params);
    });
    const queued: Record<string, unknown>[] = [];
    const db = { ...knownRepositoryDatabase(), insertInto: () => ({ values: (row: Record<string, unknown>) => {
      queued.push(row);
      return { onConflict: () => ({ returning: () => ({ executeTakeFirst: async () => ({ id: "reroute-job" }) }) }) };
    } }) };
    const action = { ...ignoredAction(), ...(sourceExclusion ? { branchExclusion: { type: "source_branch" as const, branch: "feature", matchingRule: "feature" } } : {}) };
    await expect(buildServices(message, request, db).provider.applyActions(action)).rejects.toThrow("routing context changed");
    expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "process_pull_request", workspace_id: message.workspaceId, provider_connection_id: message.providerConnectionId, payload: { changeRequest: { baseRevision: liveBase, headRevision: message.changeRequest.headRevision }, isDraft: false } });
    const payload = queued[0]!.payload as { routingKey: string };
    expect(payload.routingKey).not.toBe(message.routingKey);
  });
  it("requeues an already-retargeted signed job before recording or scoring another decision", async () => {
    const base = actionRequester(message.changeRequest.headRevision);
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { state: "open", draft: false, head: { sha: message.changeRequest.headRevision, ref: "feature" }, base: { sha: "trusted-base-123", ref: "release" } } };
      return base(route, params);
    });
    const queued: Record<string, unknown>[] = [];
    const db = { ...knownRepositoryDatabase(), insertInto: () => ({ values: (row: Record<string, unknown>) => {
      queued.push(row);
      return { onConflict: () => ({ returning: () => ({ executeTakeFirst: async () => ({ id: "reroute-job" }) }) }) };
    } }) };
    const signedJob = { ...message, changeRequest: { ...message.changeRequest, targetBranch: "main", sourceBranch: "feature" } };
    await expect(buildServices(signedJob, request, db).provider.fetchChangeRequestMetadata(signedJob)).rejects.toThrow("routing context changed");
    expect(queued).toHaveLength(1);
    expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
  });
  it("refreshes legacy jobs when the current base no longer matches their trusted revision", async () => {
    const request = vi.fn(async () => ({ data: { state: "open", draft: false, head: { sha: message.changeRequest.headRevision, ref: "feature" }, base: { sha: "release-base", ref: "release" } } }));
    const queued: Record<string, unknown>[] = [];
    const db = { ...knownRepositoryDatabase(), insertInto: () => ({ values: (row: Record<string, unknown>) => {
      queued.push(row);
      return { onConflict: () => ({ returning: () => ({ executeTakeFirst: async () => ({ id: "reroute-job" }) }) }) };
    } }) };
    await expect(buildServices(message, request, db).provider.fetchChangeRequestMetadata(message)).rejects.toThrow("routing context changed");
    expect(queued).toHaveLength(1);
  });
  it("rejects a stale head before any excluded-approval writes", async () => {
    const request = actionRequester("changed-head");
    await expect(buildServices(message, request).provider.applyActions(ignoredAction())).rejects.toThrow("head changed");
    expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
  });
  it("reuses the approval marker when retrying after provider success", async () => {
    const base = actionRequester(message.changeRequest.headRevision);
    let reviews: unknown[] = [];
    const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data: reviews };
      if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") reviews = [{ body: parameters.body }];
      return base(route, parameters);
    });
    const services = buildServices(message, request);
    await services.provider.applyActions(ignoredAction());
    await services.provider.applyActions(ignoredAction());
    expect(request.mock.calls.filter(([route]) => route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews")).toHaveLength(1);
  });
  it.each([403, 500])("preserves approval failure handling for provider status %s", async status => {
    const base = actionRequester(message.changeRequest.headRevision);
    const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") throw Object.assign(new Error("approval failed"), { status });
      if (route.startsWith("PATCH ")) return { data: {} };
      return base(route, parameters);
    });
    await expect(buildServices(message, request).provider.applyActions(ignoredAction())).rejects.toThrow("approval failed");
    const failedChecks = request.mock.calls.filter(([route, params]) => route.startsWith("PATCH ") && params.conclusion === "failure");
    expect(failedChecks).toHaveLength(status === 403 ? 1 : 0);
  });
});
