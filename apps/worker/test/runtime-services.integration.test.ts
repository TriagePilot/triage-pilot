import { describe, expect, it, vi } from "vitest";

import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import { createWorkspaceReviewerAvailability, ensureLocalWorkspace, readOperationsOverview } from "@triagepilot/db";
import {
  createWorkerHumanReviewPolicyServiceFactory,
  createWorkerRoutingServiceFactory,
} from "../src/runtime-services";
import { resolveAnalyticsScope } from "../../../packages/db/src/reviewer-backlog";
import { readAnalyticsFacts } from "../../../packages/db/src/analytics";
import { processRoutingJob, type RoutingJobMessage } from "../src/processor";

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
    baseRevision: "base-123",
    headRevision: "abc123",
  },
  isDraft: false,
  routingKey: "routing:ws_local:github:101:7:base-123:abc123",
};

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("worker routing runtime services", () => {
  it("wires routing availability to the workspace and provider connection repository", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const connection = await db.insertInto("provider_connections").values({
        workspace_id: workspaceId,
        provider: "github",
        external_connection_id: "99",
        workspace_login: "acme",
        account_type: "Organization",
        status: "active",
        permissions: {},
      }).returning("id").executeTakeFirstOrThrow();
      const at = new Date("2026-10-01T08:00:00.000Z");
      await createWorkspaceReviewerAvailability(db, workspaceId).scheduleAbsence({
        provider: "github",
        providerConnectionId: connection.id,
        externalActorId: "Actor:Preferred/7",
        startAt: new Date("2026-10-01T07:00:00.000Z"),
        endAt: new Date("2026-10-01T09:00:00.000Z"),
        now: new Date("2026-09-30T12:00:00.000Z"),
      });
      const services = createWorkerRoutingServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
      })({ ...message, workspaceId, providerConnectionId: connection.id });

      await expect(services.availability.findActive({
        workspaceId,
        providerConnectionId: connection.id,
        actors: ["Actor:Preferred/7", "Actor:Fallback/8"],
        at,
      })).resolves.toEqual([{
        externalActorId: "Actor:Preferred/7",
        startAt: new Date("2026-10-01T07:00:00.000Z"),
        endAt: new Date("2026-10-01T09:00:00.000Z"),
      }]);
    });
  });

  it("atomically persists invalid configuration identity through application processing and exact retry", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const connection = await db.insertInto("provider_connections").values({
        workspace_id: workspaceId,
        provider: "github",
        external_connection_id: "99",
        workspace_login: "acme",
        account_type: "Organization",
        status: "active",
        permissions: {},
      }).returning("id").executeTakeFirstOrThrow();
      const repository = await db.insertInto("repositories").values({
        workspace_id: workspaceId,
        provider: "github",
        provider_connection_id: connection.id,
        external_repository_id: "101",
        owner: "acme",
        name: "api",
        default_branch: "main",
        config_state: "unknown",
      }).returning("id").executeTakeFirstOrThrow();
      const scopedMessage = { ...message, workspaceId, providerConnectionId: connection.id };
      const providerRequest = vi.fn(async () => {
        throw new Error("invalid configuration must not perform provider reads or writes after loading configuration");
      });
      let currentTime = new Date("2026-08-18T12:02:00.000Z");
      const services = createWorkerRoutingServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
        createRequester: async () => ({ request: providerRequest }) as never,
        createConfigurationSource: () => ({
          async loadOrganization() { return null; },
          async loadRepository() {
            return {
              content: "version: 1\nmode: invalid\n",
              revision: "base-123",
              path: ".triagepilot.yml",
            };
          },
        }),
        clock: { now: () => currentTime },
      })(scopedMessage);

      await expect(processRoutingJob(scopedMessage, services)).resolves.toBeUndefined();
      const firstDecision = await db.selectFrom("routing_decisions")
        .select(["id", "created_at"])
        .executeTakeFirstOrThrow();
      const firstEvent = await db.selectFrom("decision_outbox")
        .select(["event_id", "occurred_at", "payload"])
        .executeTakeFirstOrThrow();
      expect(firstEvent.occurred_at).toEqual(firstDecision.created_at);
      expect(firstEvent.payload).toEqual(expect.objectContaining({
        occurredAt: firstDecision.created_at.toISOString(),
      }));

      currentTime = new Date("2026-08-18T12:17:00.000Z");
      await expect(processRoutingJob(scopedMessage, services)).resolves.toBeUndefined();

      await expect(db.selectFrom("routing_decisions")
        .select(["repository_id", "action", "action_status", "effective_config_hash"])
        .execute()).resolves.toEqual([{
        repository_id: repository.id,
        action: "configuration_failure",
        action_status: "not_applied",
        effective_config_hash: "invalid",
      }]);
      await expect(db.selectFrom("decision_outbox")
        .select(["event_id", "event_type", "occurred_at", "payload"])
        .execute()).resolves.toEqual([{
        event_id: firstEvent.event_id,
        event_type: "routing_decision",
        occurred_at: firstEvent.occurred_at,
        payload: expect.objectContaining({
          occurredAt: firstDecision.created_at.toISOString(),
          repositoryId: "101",
          changeRequestId: "7",
          action: "configuration_failure",
          effectiveConfigurationHash: "invalid",
        }),
      }]);
      await expect(db.selectFrom("repositories")
        .select(["config_state", "last_config_mode"])
        .where("id", "=", repository.id)
        .executeTakeFirstOrThrow()).resolves.toEqual({ config_state: "invalid", last_config_mode: "shadow" });
      expect(providerRequest).not.toHaveBeenCalled();
    });
  });

  it("rejects decisions for repositories absent from the configured projection", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const scopedMessage = {
        ...message,
        workspaceId,
        providerConnectionId: "00000000-0000-4000-8000-000000000099",
      };
      const buildServices = createWorkerRoutingServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
      });
      const services = buildServices(scopedMessage);

      await expect(services.fetchConfig(scopedMessage)).rejects.toThrow("repository 101 is not known");
      await expect(
        services.decisions.persistWithEvent({
          workspaceId,
          repository: scopedMessage.changeRequest.repository,
          deliveryId: "delivery-1",
          routingKey: "routing:101:7:base:abc123",
          changeRequestId: "7",
          changeRequestNumber: 7,
          headRevision: "abc123",
          mode: "shadow",
          action: "policy_approval",
          actionStatus: "not_applied",
          riskScore: 5,
          details: {},
          organizationConfigVersion: null,
          repositoryConfigPath: null,
          repositoryConfigRevision: null,
          effectiveConfigHash: "effective-hash",
          inheritanceMode: "defaults",
          configDiagnostics: [],
          configSources: {},
        }, () => {
          throw new Error("event factory must not run");
        }),
      ).rejects.toThrow("repository 101 is not known");

      await expect(db.selectFrom("provider_connections").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("repositories").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("routing_decisions").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("projects configuration and persists policy-check lifecycle for a known repository", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const connection = await db
        .insertInto("provider_connections")
        .values({
          workspace_id: workspaceId,
          provider: "github",
          external_connection_id: "99",
          workspace_login: "acme",
          account_type: "Organization",
          status: "active",
          permissions: {},
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const repository = await db
        .insertInto("repositories")
        .values({
          workspace_id: workspaceId,
          provider: "github",
          provider_connection_id: connection.id,
          external_repository_id: "101",
          owner: "acme",
          name: "api",
          default_branch: "main",
          config_state: "unknown",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const scopedMessage = { ...message, workspaceId, providerConnectionId: connection.id };
      const scopedDb = db.withPlugin({
        transformQuery(args) {
          const query = JSON.stringify(args.node);
          if (
            args.node.kind === "UpdateQueryNode" &&
            query.includes('"name":"repositories"') &&
            !query.includes('"name":"workspace_id"')
          ) throw new Error("repository update omitted workspace scope");
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      });
      const routingRequest = vi.fn(policyCheckRequester);
      const services = createWorkerRoutingServiceFactory({
        db: scopedDb,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
        createRequester: async () => ({ request: routingRequest }) as never,
      })(scopedMessage);

      await services.updateRepositoryConfigState({ configState: "valid", mode: "enforce" });
      const decision = await services.decisions.persistWithEvent(
        {
          workspaceId,
          repository: scopedMessage.changeRequest.repository,
          deliveryId: "delivery-1",
          routingKey: "routing:101:7:base:abc123",
          changeRequestId: "7",
          changeRequestNumber: 7,
          headRevision: "abc123",
          mode: "enforce",
          action: "request_human_review",
          actionStatus: "pending",
          riskScore: 5,
          selectedActors: ["@user-d82a5f"],
          details: { pullNumber: 7 },
          organizationConfigVersion: null,
          repositoryConfigPath: null,
          repositoryConfigRevision: null,
          effectiveConfigHash: "effective-hash",
          inheritanceMode: "defaults",
          configDiagnostics: [],
          configSources: {},
        },
        ({ decisionId, occurredAt }) => ({
          schemaVersion: 1,
          eventType: "routing_decision",
          eventId: `decision:${decisionId}:v1`,
          occurredAt: occurredAt.toISOString(),
          workspaceId,
          provider: "github",
          decisionId,
          repositoryId: "101",
          changeRequestId: "7",
          routingKey: "routing:101:7:base:abc123",
          mode: "enforce",
          action: "request_human_review",
          riskScore: 5,
          selectedActors: ["@user-d82a5f"],
          effectiveConfigurationHash: "effective-hash",
        }),
      );
      const failedAt = new Date("2026-08-18T12:03:00.000Z");
      await services.decisions.markActionFailed(decision.decisionId, "GitHub denied the action", failedAt);
      await services.applyDecisionActions({
        action: "request_human_review",
        decisionId: decision.decisionId,
        expectedHeadSha: "abc123",
        riskTier: "medium",
        selectedReviewers: ["@user-d82a5f"],
      });

      const policyServices = createWorkerHumanReviewPolicyServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
        createRequester: async () => ({ request: policyCheckRequester }) as never,
      })({
        kind: "evaluate_human_review_policy",
        deliveryId: "review-delivery-1",
        workspaceId,
        providerConnectionId: connection.id,
        changeRequest: {
          repository: { provider: "github", externalId: "101", owner: "acme", name: "api" },
          externalId: "7",
          number: 7,
        },
      });
      await expect(policyServices.findDecision({ repositoryId: "101", pullNumber: 7 })).resolves.toEqual(
        expect.objectContaining({
          decisionId: decision.decisionId,
          policyCheckRunId: "71",
          policyCheckState: "in_progress",
        }),
      );
      await policyServices.persistState({ decisionId: decision.decisionId, state: "success" });

      await expect(
        db
          .selectFrom("repositories")
          .select(["config_state", "last_config_mode"])
          .where("id", "=", repository.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ config_state: "valid", last_config_mode: "enforce" });
      await expect(
        db
          .selectFrom("routing_decisions")
          .select([
            "repository_id",
            "mode",
            "action_status",
            "action_error",
            "action_failed_at",
            "details",
            "pull_number",
            "head_sha",
            "policy_check_run_id",
            "policy_check_state",
          ])
          .where("id", "=", decision.decisionId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        repository_id: repository.id,
        mode: "enforce",
        action_status: "failed",
        action_error: "GitHub denied the action",
        action_failed_at: failedAt,
        details: { pullNumber: 7 },
        pull_number: 7,
        head_sha: "abc123",
        policy_check_run_id: "71",
        policy_check_state: "success",
      });
      routingRequest.mockClear();
      await db.updateTable("provider_connections").set({ status: "suspended" }).where("id", "=", connection.id).execute();
      await expect(services.applyDecisionActions({
        action: "request_human_review", decisionId: decision.decisionId, expectedHeadSha: "abc123", riskTier: "medium", selectedReviewers: ["@user-d82a5f"], reviewersToRequest: ["@user-d82a5f"],
      })).rejects.toThrow("not known");
      expect(routingRequest).not.toHaveBeenCalled();
    });
  });
});

const policyCheckRequester = async (route: string, parameters: Record<string, unknown>) => {
  if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
    return { data: { state: "open", draft: false, base: { sha: "base-123", ref: "main" }, head: { sha: "abc123", ref: "feature" } } };
  }
  if (route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy") {
    return { data: { id: 71 } };
  }
  if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
    return { data: { check_runs: [] } };
  }
  if (
    route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments" ||
    route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels" ||
    route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
  ) return { data: [] };
  if (route.startsWith("POST ")) return { data: {} };
  throw new Error(`unexpected GitHub route: ${route}`);
};

it.runIf(Boolean(process.env.TEST_DATABASE_URL)).each([
  { mode: "enforce", target: true },
  { mode: "enforce", target: false },
  { mode: "shadow", target: true },
  { mode: "shadow", target: false },
] as const)("persists $mode branch exclusions atomically with unscored operations/analytics (target: $target)", async ({ mode, target }) => {
  await withPostgresTestDatabase(async db => {
    const workspaceId = await ensureLocalWorkspace(db);
    const connection = await db.insertInto("provider_connections").values({ workspace_id: workspaceId, provider: "github", external_connection_id: "99", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("repositories").values({ workspace_id: workspaceId, provider: "github", provider_connection_id: connection.id, external_repository_id: "101", owner: "acme", name: "api", default_branch: "main", config_state: "unknown" }).execute();
    const scopedMessage = { ...message, workspaceId, providerConnectionId: connection.id };
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { state: "open", draft: false, head: { sha: "abc123", ref: "dependabot/npm" }, base: { sha: "base-123", ref: "main" }, user: { login: "author" } } };
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") return { data: { check_runs: [] } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews" || route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") return { data: [] };
      if (route === "POST /repos/{owner}/{repo}/check-runs") return { data: { id: params.name === "triagepilot/human-review-policy" ? 71 : 72 } };
      if (route.startsWith("POST ")) return { data: {} };
      throw new Error(`Excluded PR must not read ${route}`);
    });
    const services = createWorkerRoutingServiceFactory({ db, github: { appId: "123", privateKey: "test-key" }, createRequester: async () => ({ request }), createConfigurationSource: () => ({
      async loadOrganization() { return null; },
      async loadRepository(input) {
        expect(input.trustedRevision).toBe("base-123");
        return { content: `mode: ${mode}\nrouting:\n  exclude_target_branches: [${target ? "main" : "other"}]\n  exclude_source_branch_patterns: [dependabot/**]\n`, path: ".triagepilot.yml", revision: "base-123" };
      },
    }) })(scopedMessage);
    services.reviewerBacklog = vi.fn(async () => { throw new Error("Excluded PR must not read workloads"); });
    services.availability.findActive = vi.fn(async () => { throw new Error("Excluded PR must not read availability"); });
    await processRoutingJob(scopedMessage, services);
    await processRoutingJob(scopedMessage, services);
    const rows = await db.selectFrom("routing_decisions").selectAll().execute();
    expect(rows).toHaveLength(1);
    const decision = rows[0]!;
    const branchExclusion = target ? { type: "target_branch", branch: "main", matchingRule: "main" } : { type: "source_branch", branch: "dependabot/npm", matchingRule: "dependabot/**" };
    expect(decision).toMatchObject({ mode, action: "policy_approval", risk_score: 0, selected_reviewers: [], action_status: mode === "enforce" ? "succeeded" : "not_applied", policy_check_state: mode === "enforce" ? "success" : "not_started", repository_config_revision: "base-123", details: { risk: null, branchExclusion, routing: { requestedReviewerCount: 0, selectedReviewers: [] } } });
    const events = await db.selectFrom("decision_outbox").selectAll().execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ decisionId: decision.id, action: "policy_approval", riskScore: 0, selectedActors: [], branchExclusion, effectiveConfigurationHash: decision.effective_config_hash });
    const overview = await readOperationsOverview(db, workspaceId, { githubOrganization: "acme", githubAppId: "123", now: new Date(), heartbeatStaleAfterMs: 30_000 });
    expect(overview.decisions[0]).toMatchObject({ riskScore: null, riskBreakdown: null, branchExclusion, requestedReviewerCount: 0 });
    const scope = await resolveAnalyticsScope(db, workspaceId, { githubOrganization: "acme", repositoryIds: [] });
    const facts = await readAnalyticsFacts(db, scope, { start: new Date(decision.created_at.getTime() - 1), end: new Date(Date.now() + 1000) });
    expect(facts.latestDecisions).toHaveLength(1);
    expect(facts.latestDecisions[0]).toMatchObject({ riskScore: null, riskTier: null, requiredReviews: 0 });
    expect(facts.assignments).toEqual([]);
    expect(request.mock.calls.filter(([route]) => route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews")).toHaveLength(mode === "enforce" ? 1 : 0);
    if (mode === "shadow") expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
  });
});

it.runIf(Boolean(process.env.TEST_DATABASE_URL)).each(["draft", "closed", "retarget"] as const)(
  "persists an aborted exclusion when the live PR changes to %s, then honors fresh routing",
  async change => {
    await withPostgresTestDatabase(async db => {
      const workspaceId = await ensureLocalWorkspace(db);
      const connection = await db.insertInto("provider_connections").values({ workspace_id: workspaceId, provider: "github", external_connection_id: "99", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("repositories").values({ workspace_id: workspaceId, provider: "github", provider_connection_id: connection.id, external_repository_id: "101", owner: "acme", name: "api", default_branch: "main", config_state: "unknown" }).execute();
      const scopedMessage = { ...message, workspaceId, providerConnectionId: connection.id,
        changeRequest: { ...message.changeRequest, sourceBranch: "feature", targetBranch: "main" } };
      let reads = 0;
      let changed = false;
      let checkId = 70;
      const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          if (++reads >= 2 && change !== "retarget") changed = true;
          return { data: { state: changed && change === "closed" ? "closed" : "open", draft: changed && change === "draft",
            head: { sha: "abc123", ref: "feature" }, base: { sha: "base-123", ref: changed && change === "retarget" ? "release" : "main" }, user: { login: "author" } } };
        }
        if (route === "POST /repos/{owner}/{repo}/check-runs") {
          if (change === "retarget") changed = true;
          return { data: { id: ++checkId } };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") return { data: [{ filename: "README.md", additions: 1, deletions: 0 }] };
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits") return { data: [] };
        return policyCheckRequester(route, params);
      });
      const factory = createWorkerRoutingServiceFactory({ db, github: { appId: "123", privateKey: "test-key" }, createRequester: async () => ({ request }), createConfigurationSource: () => ({
        async loadOrganization() { return null; },
        async loadRepository() {
          return { content: 'mode: enforce\nrouting:\n  exclude_target_branches: [main]\nrisk:\n  paths:\n    - pattern: README.md\n      weight: 50\n      tag: docs\nownership:\n  fallback_reviewers: ["@reviewer"]\n', path: ".triagepilot.yml", revision: "base-123" };
        },
      }) });
      await expect(processRoutingJob(scopedMessage, factory(scopedMessage))).rejects.toThrow(change === "closed" ? "not open" : "routing context changed");
      expect(await db.selectFrom("routing_decisions").select(["action_status", "policy_check_state"]).executeTakeFirstOrThrow())
        .toEqual({ action_status: "failed", policy_check_state: change === "retarget" ? "success" : "not_started" });
      const writes = request.mock.calls.filter(([route]) => !route.startsWith("GET "));
      expect(writes).toHaveLength(change === "retarget" ? 1 : 0);
      const jobs = await db.selectFrom("jobs").selectAll().execute();
      expect(jobs).toHaveLength(change === "closed" ? 0 : 1);
      if (change === "closed") return;
      const reroute = jobs[0]!.payload as RoutingJobMessage;
      await processRoutingJob(reroute, factory(reroute));
      const decisions = await db.selectFrom("routing_decisions").select(["action", "action_status", "policy_check_state"]).execute();
      expect(decisions).toHaveLength(change === "draft" ? 1 : 2);
      if (change === "retarget") {
        expect(decisions).toContainEqual({ action: "request_human_review", action_status: "succeeded", policy_check_state: "in_progress" });
        expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", expect.objectContaining({ reviewers: ["reviewer"] }));
      }
      expect(request.mock.calls.some(([route]) => route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews")).toBe(false);
    });
  },
);

it.runIf(Boolean(process.env.TEST_DATABASE_URL)).each([
  { name: "target retarget on identical commits", sourceRule: false, liveTarget: "release", liveSource: "feature", liveBase: "base-123" },
  { name: "target retarget with different configuration", sourceRule: false, liveTarget: "release", liveSource: "feature", liveBase: "release-base" },
  { name: "changed source branch", sourceRule: true, liveTarget: "main", liveSource: "feature", liveBase: "base-123" },
  { name: "source exclusion under a new target policy", sourceRule: true, liveTarget: "release", liveSource: "automation/pkg", liveBase: "release-base" },
])("reroutes $name before approving, then applies the current policy", async ({ sourceRule, liveTarget, liveSource, liveBase }) => {
  await withPostgresTestDatabase(async db => {
    const workspaceId = await ensureLocalWorkspace(db);
    const connection = await db.insertInto("provider_connections").values({ workspace_id: workspaceId, provider: "github", external_connection_id: "99", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("repositories").values({ workspace_id: workspaceId, provider: "github", provider_connection_id: connection.id, external_repository_id: "101", owner: "acme", name: "api", default_branch: "main", config_state: "unknown" }).execute();
    const initialSource = sourceRule ? "automation/pkg" : "feature";
    const scopedMessage = { ...message, workspaceId, providerConnectionId: connection.id, changeRequest: { ...message.changeRequest, sourceBranch: initialSource, targetBranch: "main" } };
    let reads = 0;
    let currentBase = liveBase;
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        reads++;
        return { data: { state: "open", draft: false, head: { sha: "abc123", ref: reads === 1 ? initialSource : liveSource }, base: { sha: reads === 1 ? "base-123" : currentBase, ref: reads === 1 ? "main" : liveTarget }, user: { login: "author" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") return { data: [{ filename: "README.md", additions: 1, deletions: 0 }] };
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") return { data: { check_runs: [] } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits" || route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews" || route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments" || route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") return { data: [] };
      if (route === "POST /repos/{owner}/{repo}/check-runs") return { data: { id: params.name === "triagepilot/human-review-policy" ? 71 : 72 } };
      if (route.startsWith("POST ")) return { data: {} };
      throw new Error(`Unexpected provider read: ${route}`);
    });
    const revisions: string[] = [];
    const factory = createWorkerRoutingServiceFactory({ db, github: { appId: "123", privateKey: "test-key" }, createRequester: async () => ({ request }), createConfigurationSource: () => ({
      async loadOrganization() { return null; },
      async loadRepository(input) {
        revisions.push(input.trustedRevision);
        const exclusion = input.trustedRevision === "base-123" ? `routing:\n  ${sourceRule ? "exclude_source_branch_patterns: [automation/**]" : "exclude_target_branches: [main]"}\n` : "";
        return { content: `mode: enforce\n${exclusion}risk:\n  paths:\n    - pattern: README.md\n      weight: 50\n      tag: docs\nownership:\n  fallback_reviewers: [\"@reviewer\"]\n`, path: ".triagepilot.yml", revision: input.trustedRevision };
      },
    }) });
    await expect(processRoutingJob(scopedMessage, factory(scopedMessage))).rejects.toThrow("routing context changed");
    expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
    expect(await db.selectFrom("routing_decisions").select(["action_status", "policy_check_state"]).executeTakeFirstOrThrow()).toEqual({ action_status: "failed", policy_check_state: "not_started" });
    // Retry the old job in a fresh worker context: it must deduplicate the same replacement.
    await expect(processRoutingJob(scopedMessage, factory(scopedMessage))).rejects.toThrow("routing context changed");
    const jobs = await db.selectFrom("jobs").selectAll().execute();
    expect(jobs).toHaveLength(1);
    const reroute = jobs[0]!.payload as RoutingJobMessage;
    expect(reroute.changeRequest).toMatchObject({ baseRevision: liveBase, headRevision: "abc123", sourceBranch: liveSource, targetBranch: liveTarget });
    expect(reroute.routingKey).not.toBe(message.routingKey);
    await processRoutingJob(reroute, factory(reroute));
    const current = await db.selectFrom("routing_decisions").selectAll().where("routing_key", "=", reroute.routingKey).executeTakeFirstOrThrow();
    expect(current).toMatchObject({ action: "request_human_review", action_status: "succeeded", policy_check_state: "in_progress", repository_config_revision: liveBase });
    expect(current.details).not.toHaveProperty("branchExclusion");
    expect(revisions.at(-1)).toBe(liveBase);
    expect(request.mock.calls.some(([route]) => route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews")).toBe(false);
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", expect.objectContaining({ labels: ["triagepilot:risk-medium"] }));
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", expect.objectContaining({ reviewers: ["reviewer"] }));
    // A replay can observe a second context after the first replacement persisted.
    currentBase = "another-base";
    await expect(processRoutingJob(scopedMessage, factory(scopedMessage))).rejects.toThrow("routing context changed");
    const nextJobs = await db.selectFrom("jobs").selectAll().where("id", "!=", jobs[0]!.id).where("kind", "=", "process_pull_request").execute();
    expect(nextJobs).toHaveLength(1);
    const next = nextJobs[0]!.payload as RoutingJobMessage;
    expect(next.deliveryId).not.toBe(reroute.deliveryId);
    await processRoutingJob(next, factory(next));
    expect(await db.selectFrom("routing_decisions").select("action_status").where("routing_key", "=", next.routingKey).executeTakeFirstOrThrow()).toEqual({ action_status: "succeeded" });
  });
});
